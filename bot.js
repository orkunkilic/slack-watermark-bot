// slack_watermark_bot/bot.js
require('dotenv').config();
const { App } = require('@slack/bolt');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');

const tmpDir = './tmp';
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

const userUploads = {}; // Store PDF per user_id

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
  port: process.env.PORT || 3000
});

async function addWatermark(input, output, watermarkText) {
  const bytes = fs.readFileSync(input);
  const pdfDoc = await PDFDocument.load(bytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();

  pages.forEach((page) => {
    const { width, height } = page.getSize();
    page.drawText(`CONFIDENTIAL - ${watermarkText}`, {
      x: width / 2 - 250,
      y: height / 3,
      size: 36,
      font,
      color: rgb(0.75, 0.75, 0.75),
      rotate: degrees(45),
      opacity: 0.3,
    });
  });

  const outputBytes = await pdfDoc.save();
  fs.writeFileSync(output, outputBytes);
}

async function flattenPDF(inputPath, outputPath) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();

  const base64 = fs.readFileSync(inputPath).toString('base64');
  await page.goto(`data:application/pdf;base64,${base64}`, { waitUntil: 'networkidle0' });
  await page.waitForTimeout(500);

  const pdfDoc = await PDFDocument.create();
  const screenshot = await page.screenshot({ fullPage: true });
  const image = await pdfDoc.embedPng(screenshot);
  const newPage = pdfDoc.addPage([image.width, image.height]);
  newPage.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });

  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(outputPath, pdfBytes);
  await browser.close();
}

app.event('file_shared', async ({ event, client }) => {
  try {
    const fileId = event.file_id;
    const info = await client.files.info({ file: fileId });
    const file = info.file;

    if (file && file.filetype === 'pdf') {
      userUploads[event.user_id] = {
        id: file.id,
        name: file.name,
        url: file.url_private_download
      };
    }
  } catch (err) {
    console.error('Error in file_shared:', err);
  }
});

app.command('/watermark', async ({ command, ack, respond, client }) => {
  await ack();
  const watermark = command.text.trim();
  const upload = userUploads[command.user_id];

  if (!upload || !watermark) {
    return respond('❗ Please upload a PDF first, then run `/watermark your@email.com`');
  }

  const inputPath = `${tmpDir}/${upload.id}_original.pdf`;
  const watermarkedPath = `${tmpDir}/${upload.id}_watermarked.pdf`;
  const flattenedPath = `${tmpDir}/${upload.id}_flattened.pdf`;

  const response = await fetch(upload.url, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });
  const buffer = await response.arrayBuffer();
  fs.writeFileSync(inputPath, Buffer.from(buffer));

  await addWatermark(inputPath, watermarkedPath, `Shared with: ${watermark}`);
  await flattenPDF(watermarkedPath, flattenedPath);

  await client.files.upload({
    channels: command.channel_id,
    file: fs.createReadStream(flattenedPath),
    title: `📄 Watermarked PDF for ${watermark}`,
  });

  delete userUploads[command.user_id];
});

(async () => {
  await app.start();
  console.log('🚀 Slack PDF Watermark Bot running...');
})();
