import { chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function takeScreenshot() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });
  
  const filePath = path.join(__dirname, 'premium.html');
  await page.goto(`file://${filePath}`);
  await page.waitForTimeout(1000);
  
  const outputPath = path.join(__dirname, 'premium.png');
  await page.screenshot({
    path: outputPath,
    fullPage: false
  });
  
  console.log(`Screenshot saved to: ${outputPath}`);
  await browser.close();
}

takeScreenshot().catch(console.error);
