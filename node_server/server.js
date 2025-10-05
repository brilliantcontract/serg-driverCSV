import express from 'express';
import fs from 'fs';
import path from 'path';

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const folderName = 'jsons';
if (!fs.existsSync(folderName)) {
  fs.mkdirSync(folderName, { recursive: true });
}

const imageFolderName = 'images';
if (!fs.existsSync(imageFolderName)) {
  fs.mkdirSync(imageFolderName, { recursive: true });
}

const dataFilePath = path.join(folderName, 'data.csv');

function normaliseValue(value) {
  if (value == null) {
    return '';
  }

  if (typeof value === 'string') {
    return value.replace(/\s+/g, ' ').trim();
  }

  return JSON.stringify(value);
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  cells.push(current);

  return cells;
}

function loadCsvHeaders(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const [firstLine] = content.split(/\r?\n/, 1);

  if (!firstLine) {
    return [];
  }

  return parseCsvLine(firstLine);
}

function loadCsvRows(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);

  if (lines.length <= 1) {
    return [];
  }

  return lines.slice(1).map((line) => parseCsvLine(line));
}

function escapeCsvCell(value) {
  if (value == null) {
    return '';
  }

  const stringValue = String(value);
  const escaped = stringValue.replace(/"/g, '""');

  return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function writeCsvFile(filePath, headers, rows) {
  if (headers.length === 0) {
    return;
  }

  const headerLine = headers.map((header) => escapeCsvCell(header)).join(',');
  const rowLines = rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(','));
  const csvContent = [headerLine, ...rowLines].join('\n');

  fs.writeFileSync(filePath, `${csvContent}\n`);
}

function sanitizeFileNameSegment(segment) {
  if (!segment) {
    return '';
  }

  return segment.replace(/[\\/:*?"<>|\s]+/g, '_');
}

function ensureImageExtension(fileName, extension) {
  if (!extension) {
    return sanitizeFileNameSegment(fileName);
  }

  const sanitized = sanitizeFileNameSegment(fileName);
  if (new RegExp(`\\.${extension}$`, 'i').test(sanitized)) {
    return sanitized;
  }

  return `${sanitized}.${extension}`;
}

function determineImageExtension(contentType, sourceUrl) {
  if (contentType) {
    const mime = contentType.split(';')[0].trim().toLowerCase();
    const mimeMap = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/svg+xml': 'svg',
      'image/bmp': 'bmp',
      'image/x-icon': 'ico',
      'image/vnd.microsoft.icon': 'ico',
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

  return 'png';
}

function generateUniqueImagePath(baseName, extension) {
  const base = sanitizeFileNameSegment(baseName) || 'image';
  let candidate = ensureImageExtension(base, extension);
  let counter = 1;

  while (fs.existsSync(path.join(imageFolderName, candidate))) {
    candidate = ensureImageExtension(`${base}-${counter}`, extension);
    counter += 1;
  }

  return path.join(imageFolderName, candidate);
}

function saveImageValue(value, baseId, entryIndex, fieldKey) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const dataUrl = typeof value.dataUrl === 'string' ? value.dataUrl : null;
  if (!dataUrl || !dataUrl.startsWith('data:')) {
    return null;
  }

  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    return null;
  }

  const [, mimeType, base64Payload] = match;
  if (!base64Payload) {
    return null;
  }

  const buffer = Buffer.from(base64Payload, 'base64');

  const preferredName = (() => {
    const fromValue = typeof value.fileName === 'string' && value.fileName.trim()
      ? value.fileName.trim()
      : typeof value.name === 'string' && value.name.trim()
        ? value.name.trim()
        : null;

    if (fromValue) {
      return fromValue;
    }

    if (typeof baseId === 'string' || typeof baseId === 'number') {
      return String(baseId);
    }

    return `${entryIndex}-${fieldKey}`;
  })();

  const extensionPreference = typeof value.extension === 'string' && value.extension.trim()
    ? value.extension.trim().toLowerCase()
    : null;

  const extension = extensionPreference || determineImageExtension(value.contentType || mimeType, value.sourceUrl);
  const filePath = generateUniqueImagePath(preferredName, extension);

  fs.writeFileSync(filePath, buffer);

  return path.relative('.', filePath);
}

function processEntryImages(entry, baseId, entryIndex) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return entry;
  }

  const processed = { ...entry };

  Object.keys(processed).forEach((key) => {
    const savedPath = saveImageValue(processed[key], baseId, entryIndex, key);
    if (savedPath) {
      processed[key] = savedPath;
    }
  });

  return processed;
}

app.post('/scrape_data', (req, res) => {
  try {
    const { l_scraped_data } = req.body;

    if (!l_scraped_data) {
      return res.status(400).json({ error: 'Missing l_scraped_data field' });
    }

    let parsedData = JSON.parse(l_scraped_data);

    const baseId = !Array.isArray(parsedData) && parsedData?.id
      ? parsedData.id
      : `data_${Date.now()}`;

    let payloadArray = [];
    let baseMetadata = {};

    if (Array.isArray(parsedData)) {
      const processedArray = parsedData.map((entry, index) => processEntryImages(entry, baseId, index));
      parsedData = processedArray;

      payloadArray = processedArray.map((entry) => {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          return { ...entry };
        }

        return { value: normaliseValue(entry) };
      });
    } else if (parsedData && typeof parsedData === 'object') {
      const { data, ...rest } = parsedData;
      baseMetadata = processEntryImages(rest, baseId, 'meta');

      if (Array.isArray(data)) {
        const processedDataArray = data.map((entry, index) => processEntryImages(entry, baseId, index));
        parsedData = { ...baseMetadata, data: processedDataArray };

        payloadArray = processedDataArray.map((entry) => {
          if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            return { ...baseMetadata, ...entry };
          }

          return { ...baseMetadata, value: normaliseValue(entry) };
        });
      } else {
        parsedData = { ...baseMetadata, data };

        if (Object.keys(baseMetadata).length > 0) {
          payloadArray = [{ ...baseMetadata }];
        }
      }
    }

    if (payloadArray.length === 0) {
      console.warn('No structured data received to persist.');
    } else {
      const existingHeaders = loadCsvHeaders(dataFilePath);
      const existingRows = loadCsvRows(dataFilePath);

      const headers = Array.isArray(existingHeaders) && existingHeaders.length > 0
        ? [...existingHeaders]
        : [];

      const headerSet = new Set(headers);

      payloadArray.forEach((entry) => {
        if (entry && typeof entry === 'object') {
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

        (existingHeaders || []).forEach((header, index) => {
          rowMap[header] = row[index] ?? '';
        });

        return headers.map((header) => rowMap[header] ?? '');
      });

      const newRows = payloadArray.map((entry) => {
        return headers.map((header) => normaliseValue(entry?.[header]));
      });

      writeCsvFile(dataFilePath, headers, [...reconciledExistingRows, ...newRows]);
    }

    const fileName = `${baseId}.json`;
    const filePath = path.join(folderName, fileName);

    fs.writeFileSync(filePath, JSON.stringify(parsedData, null, 2));

    console.log(`Saved data to ${fileName}`);

    return res.status(200).json({ success: true, fileName });
  } catch (error) {
    console.error('Error processing request:', error);
    return res.status(500).json({ error: error.toString() });
  }
});

const PORT = 3010;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
