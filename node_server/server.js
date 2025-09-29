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

const dataFilePath = path.join(folderName, 'data.txt');

function normaliseValue(value) {
  if (value == null) {
    return '';
  }

  if (typeof value === 'string') {
    return value.replace(/\s+/g, ' ').trim();
  }

  return JSON.stringify(value);
}

function appendTableToFile(headers, rows) {
  if (headers.length === 0) {
    return;
  }

  const headerLine = headers.join('\t');
  const bodyLines = rows.map((row) => row.join('\t'));
  const block = [headerLine, ...bodyLines].join('\n');

  const needsLeadingNewline = fs.existsSync(dataFilePath) && fs.statSync(dataFilePath).size > 0;
  const prefix = needsLeadingNewline ? '\n' : '';

  fs.appendFileSync(dataFilePath, `${prefix}${block}\n`);
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
      const allHeaders = new Set();
      payloadArray.forEach((entry) => {
        if (entry && typeof entry === 'object') {
          Object.keys(entry).forEach((key) => allHeaders.add(key));
        }
      });

      const headers = Array.from(allHeaders);
      const rows = payloadArray.map((entry) => {
        return headers.map((key) => normaliseValue(entry?.[key]));
      });

      appendTableToFile(headers, rows);
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

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
