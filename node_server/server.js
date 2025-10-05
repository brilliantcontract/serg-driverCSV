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

app.post('/scrape_data', (req, res) => {
  try {
    const { l_scraped_data } = req.body;

    if (!l_scraped_data) {
      return res.status(400).json({ error: 'Missing l_scraped_data field' });
    }

    const parsedData = JSON.parse(l_scraped_data);

    const payloadArray = Array.isArray(parsedData)
      ? parsedData
      : Array.isArray(parsedData?.data)
        ? parsedData.data
        : parsedData && typeof parsedData === 'object'
          ? [parsedData]
          : [];

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

    const baseId = !Array.isArray(parsedData) && parsedData?.id ? parsedData.id : `data_${Date.now()}`;
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
