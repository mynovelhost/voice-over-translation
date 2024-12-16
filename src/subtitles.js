import { html, render, nothing } from "lit-html";

import youtubeUtils from "./utils/youtubeUtils.js";
import { lang, GM_fetch } from "./utils/utils.js";
import { convertSubs } from "@vot.js/shared/utils/subs";

function formatYandexSubtitlesTokens(line) {
  const lineEndMs = line.startMs + line.durationMs;
  return line.tokens.reduce((result, token, index) => {
    const nextToken = line.tokens[index + 1];
    let lastToken;
    if (result.length > 0) {
      lastToken = result[result.length - 1];
    }
    const alignRangeEnd = lastToken?.alignRange?.end ?? 0;
    const newAlignRangeEnd = alignRangeEnd + token.text.length;
    token.alignRange = {
      start: alignRangeEnd,
      end: newAlignRangeEnd,
    };
    result.push(token);
    if (nextToken) {
      const endMs = token.startMs + token.durationMs;
      const durationMs = nextToken.startMs
        ? nextToken.startMs - endMs
        : lineEndMs - endMs;
      result.push({
        text: " ",
        startMs: endMs,
        durationMs,
        alignRange: {
          start: newAlignRangeEnd,
          end: newAlignRangeEnd + 1,
        },
      });
    }
    return result;
  }, []);
}

function createSubtitlesTokens(line, previousLineLastToken) {
  const tokens = line.text.split(/([\n \t])/).reduce((result, tokenText) => {
    if (tokenText.length) {
      const lastToken = result[result.length - 1] ?? previousLineLastToken;
      const alignRangeStart = lastToken?.alignRange?.end ?? 0;
      const alignRangeEnd = alignRangeStart + tokenText.length;
      result.push({
        text: tokenText,
        alignRange: {
          start: alignRangeStart,
          end: alignRangeEnd,
        },
      });
    }
    return result;
  }, []);
  const tokenDurationMs = Math.floor(line.durationMs / tokens.length);
  const lineEndMs = line.startMs + line.durationMs;
  return tokens.map((token, index) => {
    const isLastToken = index === tokens.length - 1;
    const startMs = line.startMs + tokenDurationMs * index;
    const durationMs = isLastToken ? lineEndMs - startMs : tokenDurationMs;
    return {
      ...token,
      startMs,
      durationMs,
    };
  });
}

function getSubtitlesTokens(subtitles, subtitlesObject) {
  const result = [];
  let lastToken;
  const { source, isAutoGenerated } = subtitlesObject;
  for (let i = 0; i < subtitles.subtitles.length; i++) {
    const line = subtitles.subtitles[i];
    const hasTokens = line?.tokens?.length;

    let tokens =
      hasTokens &&
      (source === "yandex" || (source === "youtube" && isAutoGenerated))
        ? formatYandexSubtitlesTokens(line)
        : createSubtitlesTokens(line, lastToken);
    lastToken = tokens[tokens.length - 1];
    result.push({
      ...line,
      tokens,
    });
  }
  subtitles.containsTokens = true;
  return result;
}

function formatYoutubeSubtitles(subtitles, isAsr = false) {
  const result = {
    containsTokens: isAsr,
    subtitles: [],
  };
  if (typeof subtitles !== "object" || !Array.isArray(subtitles.events)) {
    console.error("[VOT] Failed to format youtube subtitles", subtitles);
    return result;
  }

  for (let i = 0; i < subtitles.events.length; i++) {
    const subtitle = subtitles.events[i];
    if (!subtitle.segs) continue;

    let durationMs = subtitle.dDurationMs;
    if (
      subtitles.events[i + 1] &&
      subtitle.tStartMs + subtitle.dDurationMs >
        subtitles.events[i + 1].tStartMs
    ) {
      durationMs = subtitles.events[i + 1].tStartMs - subtitle.tStartMs;
    }

    const tokens = [];
    let lastSegDuration = durationMs;
    for (let j = 0; j < subtitle.segs.length; j++) {
      const seg = subtitle.segs[j];
      const text = seg.utf8.trim();
      if (text === "\n") {
        continue;
      }

      const offset = seg.tOffsetMs ?? 0;
      let segDuration = durationMs;
      const nextSeg = subtitle.segs[j + 1];
      if (nextSeg?.tOffsetMs) {
        segDuration = nextSeg.tOffsetMs - offset;
        lastSegDuration -= segDuration;
      }

      tokens.push({
        text,
        startMs: subtitle.tStartMs + offset,
        durationMs: nextSeg ? segDuration : lastSegDuration,
      });
    }

    const text = tokens.map((e) => e.text).join(" ");
    if (text) {
      result.subtitles.push({
        text,
        startMs: subtitle.tStartMs,
        durationMs,
        ...(isAsr ? { tokens } : {}),
      });
    }
  }
  return result;
}

/**
 * Remove HTML tags from JSON subtitle text
 */
function clearJSONSubtitles(subtitles) {
  const { containsTokens, subtitles: subtitlesList } = subtitles;
  return {
    containsTokens,
    subtitles: subtitlesList.map((subtitleItem) => {
      subtitleItem.text = subtitleItem.text.replace(/(<([^>]+)>)/gi, "");
      return subtitleItem;
    }),
  };
}

export async function fetchSubtitles(subtitlesObject) {
  const { source, isAutoGenerated, format, url } = subtitlesObject;
  const fetchPromise = (async () => {
    try {
      const response = await GM_fetch(url, { timeout: 5000 });
      if (["vtt", "srt"].includes(format)) {
        const plain = await response.text();
        return convertSubs(plain, "json");
      }
      return await response.json();
    } catch (error) {
      console.error("[VOT] Failed to fetch subtitles.", error);
      return {
        containsTokens: false,
        subtitles: [],
      };
    }
  })();

  let subtitles = await fetchPromise;
  if (source === "youtube") {
    subtitles = formatYoutubeSubtitles(subtitles, isAutoGenerated);
  }

  if (source === "vk") {
    subtitles = clearJSONSubtitles(subtitles);
  }

  subtitles.subtitles = getSubtitlesTokens(subtitles, subtitlesObject);
  console.log("[VOT] subtitles:", subtitles);
  return subtitles;
}

export async function getSubtitles(client, videoData) {
  const {
    host,
    url,
    detectedLanguage: requestLang,
    responseLanguage,
    videoId,
    duration,
    subtitles,
  } = videoData;
  const extraSubtitles =
    host === "youtube"
      ? youtubeUtils.getSubtitles(responseLanguage)
      : subtitles ?? [];

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Timeout")), 5000),
  );

  try {
    const res = await Promise.race([
      client.getSubtitles({
        videoData: { host, url, videoId, duration },
        requestLang,
      }),
      timeoutPromise,
    ]);

    console.log("[VOT] Subtitles response: ", res);

    if (res.waiting) {
      console.error("[VOT] Failed to get yandex subtitles");
    }

    // Обработка субтитров
    let subtitles = res.subtitles ?? [];
    subtitles = subtitles.reduce((result, yaSubtitlesObject) => {
      if (
        yaSubtitlesObject.language &&
        !result.find(
          (e) =>
            e.source === "yandex" &&
            e.language === yaSubtitlesObject.language &&
            !e.translatedFromLanguage,
        )
      ) {
        result.push({
          source: "yandex",
          language: yaSubtitlesObject.language,
          url: yaSubtitlesObject.url,
        });
      }
      if (yaSubtitlesObject.translatedLanguage) {
        result.push({
          source: "yandex",
          language: yaSubtitlesObject.translatedLanguage,
          translatedFromLanguage: yaSubtitlesObject.language,
          url: yaSubtitlesObject.translatedUrl,
        });
      }
      return result;
    }, []);

    return [...subtitles, ...extraSubtitles].sort((a, b) => {
      if (a.source !== b.source) return a.source === "yandex" ? -1 : 1;
      if (
        a.language !== b.language &&
        (a.language === lang || b.language === lang)
      )
        return a.language === lang ? -1 : 1;
      if (a.source === "yandex") {
        // sort by translation
        if (a.translatedFromLanguage !== b.translatedFromLanguage) {
          // sort by translatedFromLanguage
          if (!a.translatedFromLanguage || !b.translatedFromLanguage) {
            // sort by isTranslated
            if (a.language === b.language)
              return a.translatedFromLanguage ? 1 : -1;
            return !a.translatedFromLanguage ? 1 : -1;
          }
          return a.translatedFromLanguage === requestLang ? -1 : 1;
        }
        // sort non translated by language
        if (!a.translatedFromLanguage)
          return a.language === requestLang ? -1 : 1;
      }
      // sort by isAutoGenerated
      if (a.source !== "yandex" && a.isAutoGenerated !== b.isAutoGenerated)
        return a.isAutoGenerated ? 1 : -1;
      return 0;
    });
  } catch (error) {
    if (error.message === "Timeout") {
      console.error("[VOT] Failed to get yandex subtitles. Reason: timeout");
    } else {
      console.error("[VOT] Error in getSubtitles function", error);
    }
    // на сайтах, где нет сабов всегда красит кнопку
    throw error;
  }
}

export class SubtitlesWidget {
  constructor(video, container, site) {
    this.video = video;
    this.container =
      site.host === "youtube" && site.additionalData !== "mobile"
        ? container.parentElement
        : container;
    this.site = site;

    this.subtitlesContainer = this.createSubtitlesContainer();
    this.position = { left: 25, top: 75 };
    this.dragging = { active: false, offset: { x: 0, y: 0 } };

    this.subtitles = null;
    this.lastContent = null;
    this.highlightWords = false;
    this.fontSize = 20;
    this.opacity = 0.2;
    this.maxLength = 300;
    this.maxLengthRegexp = /.{1,300}(?:\s|$)/g;

    this.abortController = new AbortController();
    this.bindEvents();
    this.updateContainerRect();
  }

  createSubtitlesContainer() {
    const container = document.createElement("vot-block");
    container.classList.add("vot-subtitles-widget");
    this.container.appendChild(container);
    return container;
  }

  bindEvents() {
    const { signal } = this.abortController;

    this.onMouseDownBound = (e) => this.onMouseDown(e);
    this.onMouseUpBound = () => this.onMouseUp();
    this.onMouseMoveBound = (e) => this.onMouseMove(e);
    this.onTimeUpdateBound = this.debounce(() => this.update(), 100);

    document.addEventListener("mousedown", this.onMouseDownBound, { signal });
    document.addEventListener("mouseup", this.onMouseUpBound, { signal });
    document.addEventListener("mousemove", this.onMouseMoveBound, { signal });
    this.video?.addEventListener("timeupdate", this.onTimeUpdateBound, {
      signal,
    });

    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(this.container);
  }

  onMouseDown(e) {
    if (this.subtitlesContainer.contains(e.target)) {
      const rect = this.subtitlesContainer.getBoundingClientRect();
      const containerRect = this.container.getBoundingClientRect();
      this.dragging = {
        active: true,
        offset: {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        },
        containerOffset: {
          x: containerRect.left,
          y: containerRect.top,
        },
      };
    }
  }

  onMouseUp() {
    this.dragging.active = false;
  }

  onMouseMove(e) {
    if (this.dragging.active) {
      e.preventDefault();
      const { width, height } = this.container.getBoundingClientRect();
      const containerOffset = this.dragging.containerOffset;
      this.position = {
        left:
          ((e.clientX - this.dragging.offset.x - containerOffset.x) / width) *
          100,
        top:
          ((e.clientY - this.dragging.offset.y - containerOffset.y) / height) *
          100,
      };
      this.applySubtitlePosition();
    }
  }

  onResize() {
    this.updateContainerRect();
  }

  updateContainerRect() {
    this.containerRect = this.container.getBoundingClientRect();
    this.applySubtitlePosition();
  }

  applySubtitlePosition() {
    const { width, height } = this.containerRect;
    const { offsetWidth, offsetHeight } = this.subtitlesContainer;

    const maxLeft = ((width - offsetWidth) / width) * 100;
    const maxTop = ((height - offsetHeight) / height) * 100;

    this.position.left = Math.max(0, Math.min(this.position.left, maxLeft));
    this.position.top = Math.max(0, Math.min(this.position.top, maxTop));

    this.subtitlesContainer.style.left = `${this.position.left}%`;
    this.subtitlesContainer.style.top = `${this.position.top}%`;
  }

  setContent(subtitles) {
    if (subtitles && this.video) {
      this.subtitles = subtitles;
      this.update();
    } else {
      this.subtitles = null;
      render(null, this.subtitlesContainer);
    }
  }

  setMaxLength(len) {
    if (typeof len === "number" && len) {
      this.maxLength = len;
      this.maxLengthRegexp = new RegExp(`.{1,${len}}(?:\\s|$)`, "g");
      this.update();
    }
  }

  setHighlightWords(value) {
    this.highlightWords = Boolean(value);
    this.update();
  }

  setFontSize(size) {
    this.fontSize = size;
    const subtitlesEl =
      this.subtitlesContainer?.querySelector(".vot-subtitles");
    if (subtitlesEl) {
      subtitlesEl.style.fontSize = `${this.fontSize}px`;
    }
  }

  /**
   * Set subtitles opacity by percentage where 100 - full transparent, 0 - not transparent
   *
   * @param {number} rate - 0-100 percent of opacity
   */
  setOpacity(rate) {
    this.opacity = ((100 - +rate) / 100).toFixed(2);
    const subtitlesEl =
      this.subtitlesContainer?.querySelector(".vot-subtitles");
    if (subtitlesEl) {
      subtitlesEl.style.setProperty("--vot-subtitles-opacity", this.opacity);
    }
  }

  update() {
    if (!this.video || !this.subtitles) return;

    const time = this.video.currentTime * 1000;
    const line = this.subtitles.subtitles?.findLast(
      (e) => e.startMs < time && time < e.startMs + e.durationMs,
    );

    if (!line) {
      render(null, this.subtitlesContainer);
      return;
    }

    let tokens = this.processTokens(line.tokens);
    const content = this.renderTokens(tokens, time);
    const stringContent = JSON.stringify(content);
    if (stringContent !== this.lastContent) {
      this.lastContent = stringContent;
      render(
        html`<vot-block
          class="vot-subtitles"
          style="font-size: ${this.fontSize}px; --vot-subtitles-opacity: ${this
            .opacity}"
          >${content}</vot-block
        >`,
        this.subtitlesContainer,
      );
    }
  }

  processTokens(tokens) {
    if (tokens.at(-1).alignRange.end <= this.maxLength) return tokens;

    let chunks = [];
    let chunkTokens = [];
    let length = 0;

    for (const token of tokens) {
      length += token.text.length;
      chunkTokens.push(token);

      if (length > this.maxLength) {
        chunks.push(this.trimChunk(chunkTokens));
        chunkTokens = [];
        length = 0;
      }
    }

    if (chunkTokens.length) chunks.push(this.trimChunk(chunkTokens));

    const time = this.video.currentTime * 1000;
    return (
      chunks.find(
        (chunk) =>
          chunk[0].startMs < time &&
          time < chunk.at(-1).startMs + chunk.at(-1).durationMs,
      ) || chunks[0]
    );
  }

  trimChunk(tokens) {
    if (tokens[0].text === " ") tokens.shift();
    if (tokens.at(-1).text === " ") tokens.pop();
    return tokens;
  }

  renderTokens(tokens, time) {
    return tokens.map((token) => {
      const passed =
        this.highlightWords &&
        (time > token.startMs + token.durationMs / 2 ||
          (time > token.startMs - 100 &&
            token.startMs + token.durationMs / 2 - time < 275));
      return html`<span class="${passed ? "passed" : nothing}"
        >${token.text.replace("\\n", "<br>")}</span
      >`;
    });
  }

  debounce(func, wait) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  release() {
    this.abortController.abort();
    this.resizeObserver.disconnect();
    this.subtitlesContainer.remove();
  }
}
