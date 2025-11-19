const sendButton = document.getElementById("send");
const timerInput = document.getElementById("timer");

let cachedInstructions = null;
let isProcessing = false;

async function loadInstructions() {
  if (cachedInstructions) {
    return cachedInstructions;
  }

  const url = chrome.runtime.getURL("list.json");
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Не удалось загрузить list.json: ${response.status}`);
  }

  const instructions = await response.json();
  if (!Array.isArray(instructions)) {
    throw new Error("list.json должен содержать массив объектов");
  }

  cachedInstructions = instructions;
  return instructions;
}

function getTimerDelay() {
  const value = Number(timerInput?.value || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function sendInstructionToBackground(instruction, delayAfterLoad) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "START_SCRAPE",
        payload: { ...instruction, timerDelay: delayAfterLoad },
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!response) {
          reject(new Error("Нет ответа от background.js"));
          return;
        }

        if (response.status !== "success") {
          reject(new Error(response.message || "Задача завершилась с ошибкой"));
          return;
        }

        resolve(response);
      }
    );
  });
}

async function processQueue() {
  if (isProcessing) {
    alert("Очередь уже обрабатывается");
    return;
  }

  try {
    isProcessing = true;
    sendButton.disabled = true;

    const instructions = await loadInstructions();
    const delayAfterLoad = getTimerDelay();

    for (const instruction of instructions) {
      await sendInstructionToBackground(instruction, delayAfterLoad);
    }

    alert("Все задания из list.json обработаны");
  } catch (error) {
    console.error("Ошибка при обработке очереди:", error);
    alert(error.message || "Произошла ошибка при запуске задач");
  } finally {
    isProcessing = false;
    sendButton.disabled = false;
  }
}

sendButton?.addEventListener("click", () => {
  processQueue();
});
