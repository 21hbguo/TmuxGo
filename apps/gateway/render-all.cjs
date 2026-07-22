const puppeteer = require('puppeteer');
const path = require('path');
const variants = ['01-liquid-glass-keycaps','02-bento-cluster','03-editorial-minimal'];
const themes = ['dark','light','high-contrast','dracula','nord','catppuccin'];
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 2 });
  for (const v of variants) {
    const url = 'file://' + path.resolve(`/home/guo/project/other/TmuxGo/design-demos/dock/${v}.html`);
    for (const t of themes) {
      await page.goto(url, { waitUntil: 'networkidle0' });
      await page.evaluate((theme)=>{
        document.querySelectorAll('.themes .dot').forEach(d=>d.removeAttribute('data-active'));
        const sel = document.querySelector('.themes .dot[data-theme="'+theme+'"]');
        if (sel) { sel.setAttribute('data-active','true'); document.documentElement.setAttribute('data-theme', theme); }
      }, t);
      await new Promise(r=>setTimeout(r,300));
      await page.screenshot({ path: `/home/guo/project/other/TmuxGo/design-demos/dock/${v}-${t}.png`, fullPage: true });
    }
    console.log('rendered', v);
  }
  await browser.close();
})();
