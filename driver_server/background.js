// background.js

/***************************************
 * Listen for START_SCRAPE message
 ***************************************/
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "START_SCRAPE") {
    const instructions = request.payload;
    handleScrapeInstructions(instructions)
      .then(() => {
        console.log({ status: "All scraping tasks completed successfully." });
        sendResponse({ status: "success" });
      })
      .catch((err) => {
        sendResponse({ status: "error", message: err.toString() });
      });
    return true; // Keep the message channel open for async response
  }
});

/*******************************************************
 * handleScrapeInstructions: processes with concurrency=5
 *******************************************************/

async function handleScrapeInstructions(instruction) {
  try {
    const result = await openAndScrape(instruction);
    console.log("✅ Scraping completed:", result);
  } catch (err) {
    console.error("❌ Scraping error:", err);
    throw err; // so it reaches sendResponse({status: 'error', message: ...})
  }
}


/************************************************************
 * openAndScrape(item): Decides proxy usage, opens background
 * tab, injects contentScriptFunction. Waits for result.
 * Also includes a 15s timeout if "complete" isn't reached.
 ************************************************************/
function openAndScrape(item) {
  return new Promise((resolve, reject) => {
    const flags = Array.isArray(item.flags) ? item.flags : [];

    let proxifiedUrl;
    if (flags.includes("disable-web-proxy")) {
      proxifiedUrl = item.url;
    } else {
      const WEB_PROXY_URL =
        "https://54.215.43.55:4002/proxy/load?key=my-little-secret&only-proxy-provider=myprivateproxy.net&url=";
      let decoded;
      try {
        decoded = decodeURIComponent(item.url);
      } catch {
        decoded = item.url;
      }
      proxifiedUrl = WEB_PROXY_URL + encodeURIComponent(decoded);
    }

    const newItem = { ...item, proxifiedUrl };

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        return reject(
          `Failed to retrieve the active tab: ${chrome.runtime.lastError.message}`
        );
      }

      const activeTab = Array.isArray(tabs) ? tabs[0] : null;

      if (!activeTab || !activeTab.id) {
        return reject("No active tab available to load scraping target");
      }

      const tabId = activeTab.id;

      chrome.tabs.update(tabId, { url: proxifiedUrl, active: true }, (tab) => {
        if (chrome.runtime.lastError) {
          return reject(
            `Failed to navigate active tab: ${chrome.runtime.lastError.message}`
          );
        }

        if (!tab) {
          return reject(`Failed to load url in active tab: ${proxifiedUrl}`);
        }

        let didLoad = false;

        const loadTimeout = setTimeout(() => {
          if (!didLoad) {
            console.warn("Page load timeout:", proxifiedUrl);
            chrome.tabs.onUpdated.removeListener(onUpdated);
            reject(`Page load timeout for: ${proxifiedUrl}`);
          }
        }, 100000);

        // This listener waits until tab finishes loading
        const onUpdated = async (updatedTabId, changeInfo) => {
          if (updatedTabId === tabId && changeInfo.status === "complete") {
            didLoad = true;
            chrome.tabs.onUpdated.removeListener(onUpdated);

            const timerDelay = Number(item.timerDelay);
            if (!Number.isNaN(timerDelay) && timerDelay > 0) {
              await waitMs(timerDelay);
            } else if (item.sleep) {
              const sleepDelay = Number(item.sleep);
              if (!Number.isNaN(sleepDelay) && sleepDelay > 0) {
                await waitMs(sleepDelay);
              }
            }

            try {
              const result = await Promise.race([
                new Promise((res, rej) => {
                  chrome.scripting.executeScript(
                    {
                      target: { tabId },
                      func: contentScriptFunction,
                      args: [newItem],
                    },
                    (responses) => {
                      if (chrome.runtime.lastError) {
                        return rej(chrome.runtime.lastError.message);
                      }
                      if (!responses || !responses[0] || responses[0].error) {
                        return rej(
                          responses?.[0]?.error || "No result from content script"
                        );
                      }
                      res(responses[0].result);
                    }
                  );
                })
              ]);

              console.log("Scraped data:", result);

              if (!result) {
                throw new Error("Scraped data is null or undefined.");
              }

              await saveScrapedDataLocally(result);

              const waiter = Array.isArray(item.requests)
                ? item.requests.find(
                  (cmd) => cmd.type?.toLowerCase().trim() === "waiter"
                )
                : null;

              if (waiter && !isNaN(waiter.time)) {
                console.log(`Post-script wait for ${waiter.time} ms...`);
                await waitMs(waiter.time);
              }

              clearTimeout(loadTimeout);
              resolve(result);

            } catch (err) {
              console.warn("Error during content script execution:", err);
              chrome.tabs.onUpdated.removeListener(onUpdated);
              clearTimeout(loadTimeout);
              reject(err);
            }
          }
        };

        chrome.tabs.onUpdated.addListener(onUpdated);
      });
    });
  });
}

/***********************************************
 * contentScriptFunction(item): runs in the tab
 ***********************************************/
async function contentScriptFunction(item) {
  const flags = Array.isArray(item.flags) ? item.flags : [];

  if (flags.includes("remove-videos")) {
    document.querySelectorAll("video").forEach((video) => video.remove());
  } else if (flags.includes("pause-videos")) {
    document.querySelectorAll("video").forEach((video) => video.pause());
  }

  if (flags.includes("clear-local-storage")) {
    try {
      localStorage.clear();
    } catch (e) {
      console.warn("Could not clear localStorage:", e);
    }
  }

  if (flags.includes("clear-session-storage")) {
    try {
      sessionStorage.clear();
    } catch (e) {
      console.warn("Could not clear sessionStorage:", e);
    }
  }

  if (flags.includes("clear-cookies")) {
    try {
      document.cookie.split(";").forEach((cookie) => {
        const name = cookie.trim().split("=")[0];
        document.cookie = `${name}=;expires=${new Date(0).toUTCString()};path=/;`;
      });
    } catch (e) {
      console.warn("Could not clear cookies:", e);
    }
  }

  if (flags.includes("disable-animation")) {
    try {
      const styleEl = document.createElement("style");
      styleEl.textContent = `
        *,
        *::before,
        *::after {
          animation: none !important;
          transition: none !important;
        }
        * {
          opacity: 1 !important;
          background-color: #FFF !important;
        }
      `;
      document.head.appendChild(styleEl);
    } catch (e) {
      console.warn("Could not disable animations/transparency:", e);
    }
  }

  if (flags.includes("disable-indexed-db")) {
    try {
      Object.defineProperty(window, "indexedDB", {
        get() {
          console.warn("indexedDB is disabled by script injection.");
          return undefined;
        },
        configurable: false,
      });
    } catch (e) {
      console.warn("Could not redefine 'indexedDB':", e);
    }
  }

  if (item.waitFor) {
    let maxChecks = 50;
    let found = false;
    while (maxChecks--) {
      if (document.querySelector(item.waitFor)) {
        found = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!found) {
      return { error: `Element ${item.waitFor} not found within time limit` };
    }
  }

  const requests = Array.isArray(item.requests) ? item.requests : [];
  const patentCommands = [];
  const extractionCommands = [];

  for (const cmd of requests) {
    const cmdType = cmd?.type?.toLowerCase().trim();
    if (!cmdType) {
      continue;
    }

    if (cmdType === "waiter") {
      const waitTime = Number(cmd.time);
      if (!isNaN(waitTime) && waitTime > 0) {
        console.log(`Waiting for ${waitTime} ms...`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
      continue;
    }

    if (cmdType === "patent") {
      patentCommands.push(cmd);
      continue;
    }

    if (
      cmdType === "attr" ||
      cmdType === "tag" ||
      cmdType === "html" ||
      cmdType === "img"
    ) {
      extractionCommands.push(cmd);
      continue;
    }

    if (cmdType === "click") {
      const els = queryElements(cmd.selector, document);
      els.forEach((el) => el.click());
      continue;
    }

    if (cmdType === "fill") {
      const els = queryElements(cmd.selector, document);
      els.forEach((el) => {
        el.value = cmd.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
      continue;
    }
  }

  function extractAttributeName(cmd) {
    if (cmd.attribute && typeof cmd.attribute === "string") {
      return cmd.attribute.trim();
    }

    if (typeof cmd.selector !== "string") {
      return null;
    }

    const matches = [...cmd.selector.matchAll(/\[([^\]]+)\]/g)];
    if (matches.length === 0) {
      return null;
    }

    const lastMatch = matches[matches.length - 1][1];
    if (!lastMatch) {
      return null;
    }

    return lastMatch.split("=")[0].trim();
  }

  function cleanText(value) {
    if (typeof value !== "string") {
      return value;
    }
    return value.replace(/\s+/g, " ").trim();
  }

  // Supports basic CSS selectors plus two extensions:
  // 1) :has-text("value") filters matched nodes by inner text containing the
  //    provided value (case-insensitive).
  // 2) Segments separated by " >> " allow step-by-step scoping; segments
  //    prefixed with "next:" switch the search root to the next sibling of the
  //    current context before applying the selector.
  //
  // Example: "#contenu >> h3:has-text('Officers') >> next:div >> p.principal"
  //  - finds the #contenu section
  //  - within it, picks the H3 whose text contains "Officers"
  //  - moves to the next sibling DIV after that H3
  //  - then selects the descendant paragraphs with the .principal class

  function normalizeSelectorSegment(segment) {
    if (typeof segment !== "string") {
      return segment;
    }

    return segment.replace(
      /(^|[^:])(\b[a-zA-Z][a-zA-Z0-9_-]*|\*)\((['"])(.*?)\3\)/g,
      (match, prefix, tagName, quote, text) =>
        `${prefix}${tagName}:has-text(${quote}${text}${quote})`
    );
  }

  function queryElements(selector, context = document) {
    if (typeof selector !== "string" || !selector.trim()) {
      return [];
    }

    const segments = selector
      .split(">>")
      .map((part) => part.trim())
      .filter(Boolean);

    let contexts = [context];

    for (const rawSegment of segments) {
      const segment = rawSegment.trim();
      if (!segment) {
        return [];
      }

      const isNextSibling = segment.toLowerCase().startsWith("next:");
      const selectorBody = normalizeSelectorSegment(
        isNextSibling ? segment.slice("next:".length).trim() : segment
      );

      const hasTextMatch = selectorBody.match(/:has-text\(("|')(.*?)(\1)\)/i);
      const textNeedle = hasTextMatch?.[2]?.toLowerCase();
      const baseSelector = hasTextMatch
        ? selectorBody.replace(hasTextMatch[0], "").trim() || "*"
        : selectorBody;
      const allowSiblingTextFallback =
        Boolean(textNeedle) && baseSelector.includes("+");

      const nextContexts = [];

      for (const ctx of contexts) {
        if (!ctx) {
          continue;
        }

        const searchRoot = isNextSibling
          ? ctx.nextElementSibling || null
          : ctx;

        if (!searchRoot) {
          continue;
        }

        let matched = [];
        try {
          // When using the custom "next:" prefix we only want the immediate
          // sibling, not every descendant that also matches the selector. This
          // prevents a segment such as "next:div" from greedily collecting all
          // nested DIVs before the following selector segments are applied.
          if (searchRoot.matches && searchRoot.matches(baseSelector)) {
            matched.push(searchRoot);
          }

          if (!isNextSibling) {
            matched.push(...searchRoot.querySelectorAll(baseSelector));
          }
        } catch (error) {
          console.warn(`Invalid selector '${baseSelector}':`, error);
          continue;
        }

        if (textNeedle) {
          const hasText = (el) =>
            (el?.textContent || "").toLowerCase().includes(textNeedle);

          matched = matched.filter((node) => {
            if (allowSiblingTextFallback) {
              // For selectors like "label:has-text('Street:') + value" only
              // accept nodes whose immediate previous sibling matches the label
              // text, instead of matching nodes that contain the text themselves.
              const sibling = node.previousElementSibling;
              return Boolean(sibling && hasText(sibling));
            }

            return hasText(node);
          });
        }

        nextContexts.push(...matched);
      }

      contexts = nextContexts;
      if (contexts.length === 0) {
        break;
      }
    }

    return contexts;
  }

  async function buildRecordFromElement(element, cmd) {
    if (!element || !cmd?.name) {
      return undefined;
    }

    const type = cmd.type?.toLowerCase().trim();
    if (type === "attr") {
      const attrName = extractAttributeName(cmd);
      if (!attrName) {
        return undefined;
      }
      const attrValue = element.getAttribute(attrName);
      if (attrValue == null) {
        return undefined;
      }
      return cleanText(attrValue);
    }

    if (type === "tag") {
      const textValue = element.textContent;
      if (textValue == null) {
        return undefined;
      }
      return cleanText(textValue);
    }

    if (type === "html") {
      return element.outerHTML;
    }

    if (type === "img") {
      const imageValue = await captureImageFromElement(element, cmd);
      return imageValue;
    }

    return undefined;
  }

  function normaliseUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") {
      return null;
    }

    try {
      return new URL(rawUrl, document.location.href).href;
    } catch {
      return rawUrl;
    }
  }

  function arrayBufferToBase64(arrayBuffer) {
    if (!arrayBuffer) {
      return "";
    }

    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  async function blobToPngDataUrl(blob) {
    if (!blob) {
      return null;
    }

    const supportOffscreen =
      typeof OffscreenCanvas !== "undefined" &&
      typeof OffscreenCanvas.prototype.convertToBlob === "function";

    if (supportOffscreen && typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bitmap.width || 1, bitmap.height || 1);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, 0, 0);
        const pngBlob = await canvas.convertToBlob({ type: "image/png" });
        bitmap.close();
        const arrayBuffer = await pngBlob.arrayBuffer();
        const base64 = arrayBufferToBase64(arrayBuffer);
        return `data:image/png;base64,${base64}`;
      } catch (error) {
        console.warn("Failed to convert image using OffscreenCanvas:", error);
      }
    }

    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(blob);
      const img = document.createElement("img");

      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          const width = img.naturalWidth || img.width || 1;
          const height = img.naturalHeight || img.height || 1;
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, width, height);
          const dataUrl = canvas.toDataURL("image/png");
          resolve(dataUrl);
        } catch (err) {
          reject(err);
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      };

      img.onerror = (err) => {
        URL.revokeObjectURL(objectUrl);
        reject(err);
      };

      img.src = objectUrl;
    }).catch((error) => {
      console.warn("Failed to convert image using fallback canvas:", error);
      return null;
    });
  }

  async function blobToOriginalDataUrl(blob) {
    if (!blob) {
      return null;
    }

    try {
      const arrayBuffer = await blob.arrayBuffer();
      const base64 = arrayBufferToBase64(arrayBuffer);
      const mimeType = blob.type || "application/octet-stream";
      return `data:${mimeType};base64,${base64}`;
    } catch (error) {
      console.warn("Failed to convert image blob to original format:", error);
      return null;
    }
  }

  function inferExtensionFromContentType(contentType) {
    if (!contentType || typeof contentType !== "string") {
      return null;
    }

    const mime = contentType.split(";")[0].trim().toLowerCase();
    const map = {
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/svg+xml": "svg",
      "image/bmp": "bmp",
      "image/x-icon": "ico",
      "image/vnd.microsoft.icon": "ico",
    };

    if (map[mime]) {
      return map[mime];
    }

    if (mime.startsWith("image/")) {
      return mime.split("/")[1];
    }

    return null;
  }

  function inferExtensionFromUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") {
      return null;
    }

    const match = rawUrl.match(/\.([a-z0-9]+)(?:[?#].*)?$/i);
    if (match) {
      return match[1].toLowerCase();
    }

    return null;
  }

  async function captureImageFromElement(element, cmd) {
    if (!element) {
      return undefined;
    }

    const src =
      element.currentSrc || element.src || element.getAttribute("src") || "";
    const absoluteUrl = normaliseUrl(src);
    if (!absoluteUrl) {
      return undefined;
    }

    try {
      const response = await fetch(absoluteUrl, {
        mode: "cors",
        credentials: "omit",
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const blob = await response.blob();
      const pngDataUrl = await blobToPngDataUrl(blob);
      const originalDataUrl = await blobToOriginalDataUrl(blob);

      if (!pngDataUrl && !originalDataUrl) {
        return undefined;
      }

      const baseFileName =
        typeof item.id !== "undefined" && item.id !== null
          ? String(item.id)
          : cmd.name || "image";

      const imageName = cmd?.name || cmd?.type || "image";
      const results = [];

      if (pngDataUrl) {
        results.push({
          type: "img",
          name: imageName,
          dataUrl: pngDataUrl,
          fileName: baseFileName,
          extension: "png",
          sourceUrl: absoluteUrl,
          contentType: "image/png",
        });
      }

      if (originalDataUrl) {
        const responseContentType = response.headers.get("content-type");
        const mimeType = blob.type || responseContentType || "application/octet-stream";
        const inferredExtension =
          inferExtensionFromContentType(mimeType) ||
          inferExtensionFromUrl(absoluteUrl) ||
          "img";

        results.push({
          type: "img",
          name: imageName,
          dataUrl: originalDataUrl,
          fileName: baseFileName,
          extension: inferredExtension,
          sourceUrl: absoluteUrl,
          contentType: mimeType,
        });
      }

      if (results.length === 1) {
        return results[0];
      }

      return results;
    } catch (error) {
      console.warn("Failed to capture image:", error);
      return undefined;
    }
  }

  async function extractValuesFromContext(context, commands) {
    if (!commands.length) {
      return [];
    }

    if (typeof context.querySelectorAll !== "function") {
      return [];
    }

    const collectedValues = new Map();
    let maxLength = 0;

    for (const extractCmd of commands) {
      if (!extractCmd.selector) {
        continue;
      }

      const elements = queryElements(extractCmd.selector, context);
      if (!elements || elements.length === 0) {
        continue;
      }

      const fieldName = extractCmd.name || extractCmd.type;
      const values = [];

      for (const element of elements) {
        const value = await buildRecordFromElement(element, extractCmd);
        if (value !== undefined) {
          values.push(value);
        }
      }

      if (values.length === 0) {
        continue;
      }

      // When a selector matches multiple elements we want to store the collected
      // values in a single field, separated by the "◙" symbol. This keeps all
      // related data together instead of spreading it across multiple records.
      // if (values.length > 1) {
      //   const joinedValue = values
      //     .map((val) => (typeof val === "string" ? val : JSON.stringify(val)))
      //     .join("◙");
      //   values.splice(0, values.length, joinedValue);
      // }

      collectedValues.set(fieldName, values);
      if (values.length > maxLength) {
        maxLength = values.length;
      }
    }

    if (maxLength === 0) {
      return [];
    }

    const records = [];
    for (let index = 0; index < maxLength; index += 1) {
      const record = {};

      for (const [fieldName, values] of collectedValues.entries()) {
        if (index < values.length) {
          record[fieldName] = values[index];
        }
      }

      if (Object.keys(record).length > 0) {
        records.push(record);
      }
    }

    return records;
  }

  const data = [];

  if (patentCommands.length > 0 && extractionCommands.length > 0) {
    for (const patentCmd of patentCommands) {
      if (!patentCmd.selector) {
        continue;
      }

      const patentElements = queryElements(patentCmd.selector, document);
      for (const patentEl of patentElements) {
        const records = await extractValuesFromContext(
          patentEl,
          extractionCommands
        );

        for (const record of records) {
          if (Object.keys(record).length > 0) {
            data.push(record);
          }
        }
      }
    }
  } else if (extractionCommands.length > 0) {
    const records = await extractValuesFromContext(document, extractionCommands);

    for (const record of records) {
      if (Object.keys(record).length > 0) {
        data.push(record);
      }
    }
  }

  return {
    id: item.id,
    timestamp: new Date().toISOString(),
    url: item.proxifiedUrl || item.url,
    data,
  };
}

/************************************************
 * Simple wait function
 ************************************************/
function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (items) => {
      if (chrome.runtime.lastError) {
        return reject(chrome.runtime.lastError);
      }
      resolve(items || {});
    });
  });
}

function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) {
        return reject(chrome.runtime.lastError);
      }
      resolve();
    });
  });
}

function normaliseValue(value) {
  if (value == null) {
    return "";
  }

  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }

  return JSON.stringify(value);
}

function escapeCsvCell(value) {
  if (value == null) {
    return "";
  }

  const stringValue = String(value);
  const escaped = stringValue.replace(/"/g, '""');

  return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function writeCsvContent(headers, rows) {
  if (!headers.length) {
    return "";
  }

  const headerLine = headers.map((header) => escapeCsvCell(header)).join(",");
  const rowLines = rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(","));
  return [headerLine, ...rowLines].join("\n") + "\n";
}

function sanitizeFileNameSegment(segment) {
  if (!segment) {
    return "";
  }

  return segment.replace(/[\\/:*?"<>|\s]+/g, "_");
}

function ensureImageExtension(fileName, extension) {
  if (!extension) {
    return sanitizeFileNameSegment(fileName);
  }

  const sanitized = sanitizeFileNameSegment(fileName);
  if (new RegExp(`\\.${extension}$`, "i").test(sanitized)) {
    return sanitized;
  }

  return `${sanitized}.${extension}`;
}

function determineImageExtension(contentType, sourceUrl) {
  if (contentType) {
    const mime = contentType.split(";")[0].trim().toLowerCase();
    const mimeMap = {
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/svg+xml": "svg",
      "image/bmp": "bmp",
      "image/x-icon": "ico",
      "image/vnd.microsoft.icon": "ico",
    };

    if (mimeMap[mime]) {
      return mimeMap[mime];
    }
  }

  if (sourceUrl) {
    const match = sourceUrl.match(/\.([a-z0-9]+)(?:[?#].*)?$/i);
    if (match) {
      return match[1].toLowerCase();
    }
  }

  return "png";
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isImageDescriptor(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.type === "string" &&
    value.type.trim().toLowerCase() === "img"
  );
}

function isDirectImagePayload(value) {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((entry) => isDirectImagePayload(entry));
  }

  return isImageDescriptor(value);
}

async function getImageNameRegistry() {
  const { imageNames } = await storageGet(["imageNames"]);
  return new Set(Array.isArray(imageNames) ? imageNames : []);
}

async function storeImageNameRegistry(registry) {
  await storageSet({ imageNames: Array.from(registry) });
}

async function reserveImageName(baseName, extension) {
  const registry = await getImageNameRegistry();
  const base = sanitizeFileNameSegment(baseName) || "image";
  let candidate = ensureImageExtension(base, extension);
  let counter = 1;

  while (registry.has(candidate)) {
    candidate = ensureImageExtension(`${base}-${counter}`, extension);
    counter += 1;
  }

  registry.add(candidate);
  await storeImageNameRegistry(registry);
  return candidate;
}

async function downloadFile({ url, filename, mimeType }) {
  const downloadUrl = mimeType
    ? `data:${mimeType};charset=utf-8,${encodeURIComponent(url)}`
    : url;

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: downloadUrl,
        filename,
        conflictAction: "overwrite",
        saveAs: false,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          return reject(chrome.runtime.lastError);
        }
        resolve(downloadId);
      }
    );
  });
}

async function saveImageValue(value, baseId, entryIndex, fieldKey) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const typeHint = typeof value.type === "string" ? value.type.trim().toLowerCase() : null;

  if (typeHint !== "img") {
    return null;
  }

  const preferredName = (() => {
    const fromValue = typeof value.fileName === "string" && value.fileName.trim()
      ? value.fileName.trim()
      : typeof value.name === "string" && value.name.trim()
        ? value.name.trim()
        : null;

    if (fromValue) {
      return fromValue;
    }

    if (typeof baseId === "string" || typeof baseId === "number") {
      return String(baseId);
    }

    const keySegment = fieldKey ? `-${fieldKey}` : "";
    return `${entryIndex}${keySegment}`;
  })();

  const extensionPreference = typeof value.extension === "string" && value.extension.trim()
    ? value.extension.trim().toLowerCase()
    : null;

  const dataUrl = typeof value.dataUrl === "string" ? value.dataUrl : null;
  const directUrl = typeof value.sourceUrl === "string" && value.sourceUrl.trim()
    ? value.sourceUrl.trim()
    : null;

  if (dataUrl && dataUrl.startsWith("data:")) {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      return null;
    }

    const [, mimeType, base64Payload] = match;
    if (!base64Payload) {
      return null;
    }

    const extension = extensionPreference || determineImageExtension(value.contentType || mimeType, value.sourceUrl);
    const candidateName = await reserveImageName(preferredName, extension);

    await downloadFile({
      url: dataUrl,
      filename: `images/${candidateName}`,
    });

    return `images/${candidateName}`;
  }

  if (directUrl) {
    const extension = extensionPreference || determineImageExtension(value.contentType, directUrl);
    const candidateName = await reserveImageName(preferredName, extension);

    await downloadFile({
      url: directUrl,
      filename: `images/${candidateName}`,
    });

    return `images/${candidateName}`;
  }

  return null;
}

async function processImageValue(value, baseId, entryIndex, fieldPath) {
  const savedPath = await saveImageValue(value, baseId, entryIndex, fieldPath);
  if (savedPath) {
    return savedPath;
  }

  if (Array.isArray(value)) {
    const results = [];
    for (let idx = 0; idx < value.length; idx += 1) {
      const nextPath = fieldPath ? `${fieldPath}-${idx}` : String(idx);
      results.push(await processImageValue(value[idx], baseId, entryIndex, nextPath));
    }
    return results;
  }

  if (value && typeof value === "object" && isPlainObject(value)) {
    const entries = {};
    const keys = Object.keys(value);
    for (const key of keys) {
      const nextPath = fieldPath ? `${fieldPath}.${key}` : key;
      entries[key] = await processImageValue(value[key], baseId, entryIndex, nextPath);
    }
    return entries;
  }

  return value;
}

async function processEntryImages(entry, baseId, entryIndex) {
  return processImageValue(entry, baseId, entryIndex, "");
}

async function saveScrapedDataLocally(scrapedData) {
  const originalPayload = scrapedData;
  let parsedData = scrapedData;

  const baseId = !Array.isArray(parsedData) && parsedData?.id
    ? parsedData.id
    : `data_${Date.now()}`;

  if (isDirectImagePayload(originalPayload)) {
    if (Array.isArray(parsedData)) {
      for (let index = 0; index < parsedData.length; index += 1) {
        await processImageValue(parsedData[index], baseId, index, "");
      }
    } else {
      await processImageValue(parsedData, baseId, "image", "");
    }

    console.log("Image payload received. Skipped JSON and CSV persistence.");
    return;
  }

  let payloadArray = [];
  let baseMetadata = {};

  if (Array.isArray(parsedData)) {
    const processedArray = [];
    for (let index = 0; index < parsedData.length; index += 1) {
      processedArray.push(await processEntryImages(parsedData[index], baseId, index));
    }
    parsedData = processedArray;

    payloadArray = processedArray.map((entry) => {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        return { ...entry };
      }

      return { value: normaliseValue(entry) };
    });
  } else if (parsedData && typeof parsedData === "object") {
    const { data, ...rest } = parsedData;
    baseMetadata = await processEntryImages(rest, baseId, "meta");

    if (Array.isArray(data)) {
      const processedDataArray = [];
      for (let index = 0; index < data.length; index += 1) {
        processedDataArray.push(await processEntryImages(data[index], baseId, index));
      }
      parsedData = { ...baseMetadata, data: processedDataArray };

      payloadArray = processedDataArray.map((entry) => {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          return { ...baseMetadata, ...entry };
        }

        return { ...baseMetadata, value: normaliseValue(entry) };
      });
    } else if (data !== undefined) {
      const processedDataValue = await processEntryImages(data, baseId, "data");
      parsedData = { ...baseMetadata, data: processedDataValue };

      if (Object.keys(baseMetadata).length > 0) {
        payloadArray = [{ ...baseMetadata }];
      }
    } else {
      parsedData = { ...baseMetadata };
      if (Object.keys(baseMetadata).length > 0) {
        payloadArray = [{ ...baseMetadata }];
      }
    }
  }

  if (payloadArray.length === 0) {
    console.warn("No structured data received to persist.");
  } else {
    const { csvHeaders, csvRows } = await storageGet(["csvHeaders", "csvRows"]);
    const existingHeaders = Array.isArray(csvHeaders) ? csvHeaders : [];
    const existingRows = Array.isArray(csvRows) ? csvRows : [];

    const headers = existingHeaders.length > 0 ? [...existingHeaders] : [];
    const headerSet = new Set(headers);

    payloadArray.forEach((entry) => {
      if (entry && typeof entry === "object") {
        Object.keys(entry).forEach((key) => {
          if (!headerSet.has(key)) {
            headerSet.add(key);
            headers.push(key);
          }
        });
      }
    });

    const reconciledExistingRows = existingRows.map((row) => {
      const rowMap = {};

      existingHeaders.forEach((header, index) => {
        rowMap[header] = row[index] ?? "";
      });

      return headers.map((header) => rowMap[header] ?? "");
    });

    const newRows = payloadArray.map((entry) => {
      return headers.map((header) => normaliseValue(entry?.[header]));
    });

    const updatedRows = [...reconciledExistingRows, ...newRows];
    await storageSet({ csvHeaders: headers, csvRows: updatedRows });

    const csvContent = writeCsvContent(headers, updatedRows);
    if (csvContent) {
      await downloadFile({
        url: csvContent,
        filename: "jsons/data.csv",
        mimeType: "text/csv",
      });
    }
  }

  const jsonContent = JSON.stringify(parsedData, null, 2);
  const fileName = `${baseId}.json`;

  await downloadFile({
    url: jsonContent,
    filename: `jsons/${fileName}`,
    mimeType: "application/json",
  });

  console.log(`Saved data to ${fileName}`);
}