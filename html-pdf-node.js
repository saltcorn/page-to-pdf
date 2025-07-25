/* Originally from:

https://github.com/mrafiqk/html-pdf-node/

*/

const puppeteer = require("@saltcorn/puppeteer-v17");
const hb = require("handlebars");
const fs = require("fs").promises;
const { getState } = require("@saltcorn/data/db/state");

module.exports;
async function generatePdf(file, options) {
  // we are using headless mode
  let args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--ignore-certificate-errors",
  ];
  if (options.args) {
    args = options.args;
    delete options.args;
  }
  if (process.env["HTTPS_PROXY"])
    args.push(`--proxy-server=${process.env["HTTPS_PROXY"]}`);

  getState().log(6, "page-to-pdf chrome args: " + JSON.stringify(args));

  const browser = await puppeteer.launch({
    args: args,
    executablePath: options.executablePath,
    ignoreHttpsErrors: true,
  });

  if (options.executablePath) delete options.executablePath;

  const page = await browser.newPage();
  if (options.cookie) {
    if (Array.isArray(options.cookie)) await page.setCookie(...options.cookie);
    else await page.setCookie(options.cookie);
  }
  delete options.footerHtml;
  delete options.headerHtml;
  delete options.footerHeight;
  delete options.headerHeight;
  try {
    await page.goto(file.url, {
      waitUntil: "networkidle0", // wait for page to load completely
    });
    if (["PNG", "JPEG", "WebP"].includes(options.format)) {
      const content = await page.$(options.css_selector || "body");
      const scopts = {
        omitBackground: !!options.omitBackground,
        type: options.format.toLowerCase(),
      };
      if (!content) throw new Error("CSS selector not matched on page");
      const imageBuffer = await content.screenshot(scopts);
      if (options.path) {
        await fs.writeFile(options.path, imageBuffer);
      }
      return imageBuffer;
    } else {
      delete options.css_selector;
      delete options.omitBackground;
      const data = await page.pdf(options);
      return Buffer.from(Object.values(data));
    }
  } finally {
    await browser.close();
  }
}

module.exports.generatePdf = generatePdf;
