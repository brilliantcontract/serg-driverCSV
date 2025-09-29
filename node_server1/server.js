import express from 'express';
import fs from 'fs';
import path from 'path';

const app = express();

// Increase payload size limit
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const folderName = 'jsons';
if (!fs.existsSync(folderName)) {
  fs.mkdirSync(folderName, { recursive: true });
}

app.post('/scrape_data', (req, res) => {
  try {
    const { l_scraped_data } = req.body;

    if (!l_scraped_data) {
      return res.status(400).json({ error: 'Missing l_scraped_data field' });
    }

    const parsedData = JSON.parse(l_scraped_data);

    const fileName = `${parsedData.id || 'unknown_id'}.json`;
    const filePath = path.join(folderName, fileName);

    fs.writeFileSync(filePath, JSON.stringify(parsedData));

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
