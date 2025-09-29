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

            if (Array.isArray(result)) {
              for (const partialResult of result) {
                await sendDataToServer(partialResult);
              }
            } else {
              await sendDataToServer(result);
            }

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

  // 1) remove or pause videos
  if (flags.includes("remove-videos")) {
    document.querySelectorAll("video").forEach((video) => video.remove());
  } else if (flags.includes("pause-videos")) {
    document.querySelectorAll("video").forEach((video) => video.pause());
  }

  // 2) clear localStorage
  if (flags.includes("clear-local-storage")) {
    try {
      localStorage.clear();
    } catch (e) {
      console.warn("Could not clear localStorage:", e);
    }
  }

  // 3) clear sessionStorage
  if (flags.includes("clear-session-storage")) {
    try {
      sessionStorage.clear();
    } catch (e) {
      console.warn("Could not clear sessionStorage:", e);
    }
  }

  // 4) clear cookies
  if (flags.includes("clear-cookies")) {
    try {
      document.cookie.split(";").forEach((cookie) => {
        const name = cookie.trim().split("=")[0];
        document.cookie = `${name}=;expires=${new Date(
          0
        ).toUTCString()};path=/;`;
      });
    } catch (e) {
      console.warn("Could not clear cookies:", e);
    }
  }

  // 5) disable animation
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

  // 6) disable indexedDB
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

  // 7) If item.waitFor => wait for that element
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

  // 8) Perform scraping & actions
  let responses = []; // array-of-arrays or final results
  let currentParentList = []; // for "select patent" logic
  let inPatentMode = false;

  // parse patent with a range :nth-child(1-5), etc.
  function parsePatentSelector(selectorValue) {
    const rangeRegex = /:nth-child\((\d+)-(\d+)\)/;
    const match = selectorValue.match(rangeRegex);

    if (!match) {
      // no range => single parent
      return [{ selector: selectorValue, items: [] }];
    }

    const start = parseInt(match[1], 10);
    const end = parseInt(match[2], 10);
    if (isNaN(start) || isNaN(end) || start > end) {
      console.warn("Invalid range in patent selector:", selectorValue);
      return [{ selector: selectorValue, items: [] }];
    }

    let baseSel = selectorValue.replace(rangeRegex, ":nth-child");
    let result = [];
    for (let i = start; i <= end; i++) {
      result.push({ selector: baseSel + `(${i})`, items: [] });
    }
    return result;
  }

  if (Array.isArray(item.requests)) {
    for (const cmd of item.requests) {
      // fix trailing spaces in type => "fill " => "fill"
      const cmdType = cmd.type?.toLowerCase().trim();

      if (cmdType === "select patent") {
        // finalize old parents
        if (currentParentList.length > 0) {
          currentParentList.forEach((p) => {
            if (p.items.length > 0) {
              responses.push(p.items);
            }
          });
        }
        currentParentList = parsePatentSelector(cmd.selector);
        inPatentMode = true;
      } else if (cmdType === "select child") {
        if (!inPatentMode || currentParentList.length === 0) {
          console.warn("Child selector with no parent. Skipping.");
          continue;
        }
        // For each parent, find child
        currentParentList.forEach((pObj) => {
          const combined = pObj.selector + " " + cmd.selector;
          const els = document.querySelectorAll(combined);
          els.forEach((el) => {
            const attrs = [];
            for (const attr of el.attributes) {
              attrs.push({ name: attr.name, value: attr.value });
            }
            pObj.items.push({
              // remove line breaks, tabs, extra spaces:
              html: el.outerHTML.replace(/\s+/g, " ").trim(),
              attributes: attrs,
              command_name: cmd.name,
            });
          });
        });
      } else if (cmdType === "select") {
        // finalize old parent group
        if (currentParentList.length > 0) {
          currentParentList.forEach((p) => responses.push(p.items));
          currentParentList = [];
        }
        inPatentMode = false;

        const els = document.querySelectorAll(cmd.selector);
        let group = [];
        els.forEach((el) => {
          const attrs = [];
          for (const attr of el.attributes) {
            attrs.push({ name: attr.name, value: attr.value });
          }
          group.push({
            html: el.outerHTML.replace(/\s+/g, " ").trim(),
            attributes: attrs,
            command_name: cmd.name,
          });
        });
        if (group.length > 0) {
          responses.push(group);
        }
      } else if (/^select-\d+$/i.test(cmdType)) {
        if (currentParentList.length > 0) {
          currentParentList.forEach((p) => responses.push(p.items));
          currentParentList = [];
        }
        inPatentMode = false;

        const match = cmdType.match(/^select-(\d+)$/i);
        const selectorIndex = match ? parseInt(match[1], 10) : 0;

        const els = document.querySelectorAll(cmd.selector);
        let group = [];

        els.forEach((el) => {
          const attrs = [];
          for (const attr of el.attributes) {
            attrs.push({ name: attr.name, value: attr.value });
          }
          group.push({
            html: el.outerHTML.replace(/\s+/g, " ").trim(),
            attributes: attrs,
            command_name: cmd.name,
            selector_group: selectorIndex
          });
        });

        if (group.length > 0) {
          if (!responses[selectorIndex]) {
            responses[selectorIndex] = [];
          }
          responses[selectorIndex].push(...group);
        }
      } else if (cmdType === "fill") {
        inPatentMode = false;

        const els = document.querySelectorAll(cmd.selector);
        els.forEach((el) => {
          el.value = cmd.value;
        });
      } else if (cmdType === "click") {
        inPatentMode = false;

        const els = document.querySelectorAll(cmd.selector);
        els.forEach((el) => {
          el.click();
        });
      } else if (cmdType === "waiter") {
        inPatentMode = false;

        const waitTime = Number(cmd.time);
        if (!isNaN(waitTime) && waitTime > 0) {
          console.log(`Waiting for ${waitTime} ms...`);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        } else {
          console.warn("Invalid or missing 'time' for waiter command.");
        }
      }
    }

    if (currentParentList.length > 0) {
      currentParentList.forEach((p) => {
        if (p.items.length > 0) {
          responses.push(p.items);
        }
      });
    }
  }

  const hasNumberedSelect = Array.isArray(item.requests)
  ? item.requests.some((cmd) => /^select-\d+$/i.test(cmd.type?.trim()))
  : false;

if (hasNumberedSelect) {
  const finalResults = [];

  if (Array.isArray(responses)) {
    responses.forEach((group, index) => {
      if (group && group.length > 0) {
        finalResults.push({
          id: `${item.id}-${index}`,
          timestamp: new Date().toISOString(),
          url: item.proxifiedUrl || item.url,
          responses: group
        });
      }
    });
  }

  return finalResults;
} else {
  return {
    id: item.id,
    timestamp: new Date().toISOString(),
    url: item.proxifiedUrl || item.url,
    responses
  };
}

  return finalResults;

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

  const resp = await fetch("http://localhost:3000/scrape_data", {
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

