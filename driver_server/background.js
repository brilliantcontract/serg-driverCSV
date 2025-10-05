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

    chrome.tabs.create({ url: proxifiedUrl, active: false }, (tab) => {
      if (!tab || !tab.id) {
        return reject(`Failed to create tab for: ${proxifiedUrl}`);
      }

      const tabId = tab.id;
      let didLoad = false;

      const loadTimeout = setTimeout(async () => {
        if (!didLoad) {
          console.warn("Page load timeout:", proxifiedUrl);
          try {
            await chrome.tabs.remove(tabId);
          } catch { }
          console.warn("Page load timeout:", proxifiedUrl);
        }
      }, 100000);

      // This listener waits until tab finishes loading
      const onUpdated = async (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === "complete") {
          didLoad = true;
          chrome.tabs.onUpdated.removeListener(onUpdated);

          if (item.sleep) {
            await waitMs(item.sleep);
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

            await sendDataToServer(result);

            const waiter = Array.isArray(item.requests)
              ? item.requests.find(
                (cmd) => cmd.type?.toLowerCase().trim() === "waiter"
              )
              : null;

            if (waiter && !isNaN(waiter.time)) {
              console.log(`Post-script wait for ${waiter.time} ms...`);
              await waitMs(waiter.time);
            }

            await chrome.tabs.remove(tabId);
            clearTimeout(loadTimeout);
            resolve(result);

          } catch (err) {
            console.warn("Error during content script execution:", err);
            try {
              await chrome.tabs.remove(tabId);
              clearTimeout(loadTimeout);
            } catch { }
            reject(err);
          }
        }
      };

      chrome.tabs.onUpdated.addListener(onUpdated);
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
      const els = document.querySelectorAll(cmd.selector);
      els.forEach((el) => el.click());
      continue;
    }

    if (cmdType === "fill") {
      const els = document.querySelectorAll(cmd.selector);
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
        const bytes = new Uint8Array(arrayBuffer);
        let binary = "";
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const chunk = bytes.subarray(i, i + chunkSize);
          binary += String.fromCharCode.apply(null, chunk);
        }
        return `data:image/png;base64,${btoa(binary)}`;
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

      if (!pngDataUrl) {
        return undefined;
      }

      const baseFileName =
        typeof item.id !== "undefined" && item.id !== null
          ? String(item.id)
          : cmd.name || "image";

      return {
        dataUrl: pngDataUrl,
        fileName: baseFileName,
        sourceUrl: absoluteUrl,
        contentType: "image/png",
      };
    } catch (error) {
      console.warn("Failed to capture image:", error);
      return undefined;
    }
  }

  async function extractValuesFromContext(context, commands) {
    const record = {};

    for (const extractCmd of commands) {
      if (!extractCmd.selector) {
        continue;
      }

      if (typeof context.querySelector !== "function") {
        continue;
      }

      const targetEl = context.querySelector(extractCmd.selector);
      if (!targetEl) {
        continue;
      }

      const value = await buildRecordFromElement(targetEl, extractCmd);
      if (value !== undefined) {
        record[extractCmd.name || extractCmd.type] = value;
      }
    }

    return record;
  }

  const data = [];

  if (patentCommands.length > 0 && extractionCommands.length > 0) {
    for (const patentCmd of patentCommands) {
      if (!patentCmd.selector) {
        continue;
      }

      const patentElements = document.querySelectorAll(patentCmd.selector);
      for (const patentEl of patentElements) {
        const record = await extractValuesFromContext(
          patentEl,
          extractionCommands
        );

        if (Object.keys(record).length > 0) {
          data.push(record);
        }
      }
    }
  } else if (extractionCommands.length > 0) {
    const record = await extractValuesFromContext(document, extractionCommands);

    if (Object.keys(record).length > 0) {
      data.push(record);
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

/************************************************
 * Send data to local server
 ************************************************/
async function sendDataToServer(scrapedData) {
  const bodyObj = {
    l_scraped_data: JSON.stringify(scrapedData),
  };

  const resp = await fetch("http://localhost:3010/scrape_data", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bodyObj),
  });

  if (!resp.ok) {
    throw new Error(`Server responded with ${resp.status}`);
  }

  const respJson = await resp.json();
  console.log("Local server response:", respJson);
}

