require('dotenv').config();
const { App } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const puppeteer = require('puppeteer');

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const tmpDir = './tmp';
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

// Add watermark to PDF
async function addWatermark(input, output, watermarkText) {
  const bytes = fs.readFileSync(input);
  const pdfDoc = await PDFDocument.load(bytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();

  pages.forEach((page) => {
    const { width, height } = page.getSize();
    page.drawText(`CONFIDENTIAL • ${watermarkText}`, {
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

  const pdfBuffer = fs.readFileSync(inputPath);
  const base64 = pdfBuffer.toString('base64');
  await page.goto(`data:application/pdf;base64,${base64}`, { waitUntil: 'networkidle0' });

  const numPages = await page.evaluate(() => {
    return window.PDFViewerApplication?.pdfDocument?.numPages || 1;
  });

  const pdfDoc = await PDFDocument.create();

  for (let i = 1; i <= numPages; i++) {
    await page.evaluate((pageNum) => {
      window.PDFViewerApplication.page = pageNum;
    }, i);

    await page.waitForTimeout(200); // wait for page to render

    const screenshot = await page.screenshot({ fullPage: true });
    const image = await pdfDoc.embedPng(screenshot);
    const newPage = pdfDoc.addPage([image.width, image.height]);
    newPage.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }

  const flattenedBytes = await pdfDoc.save();
  fs.writeFileSync(outputPath, flattenedBytes);
  await browser.close();
}

app.command('/watermark', async ({ command, ack, respond, client }) => {
  await ack();

  const watermark = command.text.trim();
  if (!watermark) return respond("❗ Please provide watermark text: `/watermark john@example.com`");

  const result = await client.files.list({ user: command.user_id });
  const pdf = result.files.find(f => f.filetype === 'pdf');

  if (!pdf) return respond("❌ No PDF found in recent uploads. Please upload a PDF first.");

  const inputPath = `${tmpDir}/${pdf.id}_original.pdf`;
  const watermarkedPath = `${tmpDir}/${pdf.id}_watermarked.pdf`;
  const finalPath = `${tmpDir}/${pdf.id}_flattened.pdf`;

  const fileRes = await fetch(pdf.url_private_download, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });
  const buffer = await fileRes.buffer();
  fs.writeFileSync(inputPath, buffer);

  await addWatermark(inputPath, watermarkedPath, `Shared with: ${watermark}`);
  await flattenPDF(watermarkedPath, finalPath);

  const upload = await client.files.upload({
    channels: command.channel_id,
    file: fs.createReadStream(finalPath),
    title: `📄 Watermarked PDF for ${watermark}`,
  });

  respond(`✅ Uploaded watermarked PDF: ${upload.file.permalink}`);
});

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('🚀 Slack watermark bot running');
})();