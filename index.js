const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Page = require("@saltcorn/data/models/page");
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");

const { URL } = require("url");
const { generatePdf } = require("@saltcorn/html-pdf-node");
const fs = require("fs");

module.exports = {
  sc_plugin_api_version: 1,
  actions: {
    page_to_pdf: {
      configFields: async () => {
        const pages = await Page.find();
        return [
          {
            name: "page",
            label: "Page",
            type: "String",
            attributes: { options: pages.map((p) => p.name) },
          },
          {
            name: "statevars",
            label: "State variables",
            type: "String",
            sublabel:
              "Which state variable to capture in printed page. Separate by comma.",
          },
        ];
      },
      run: async ({
        row,
        referrer,
        req,
        configuration: { page, statevars },
      }) => {
        const qstate = {};
        const xfer_vars = new Set(
          (statevars || "")
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s)
        );
        for (const [name, value] of new URL(referrer || "").searchParams) {
          if (xfer_vars.has(name)) qstate[name] = value;
        }
        const thePage = await Page.findOne({ name: page });
        if (thePage) {
          const contents = await thePage.run(qstate, { res: {}, req });
          const html = await renderPage(contents, thePage, req);

          const executablePath = fs.existsSync("/usr/bin/chromium-browser")
            ? "/usr/bin/chromium-browser"
            : undefined;
          let options = { format: "A4", path: "/tmp/page.pdf", executablePath };
          return await generatePdf({ content: html }, options);
        }
      },
    },
  },
};

const renderPage = async (contents, page, req) => {
  const state = getState();
  const layout = state.getLayout(req.user);
  const version_tag = db.connectObj.version_tag;

  const headers = [
    ...state.headers,
    {
      headerTag: `<script>var _sc_globalCsrf = "${req.csrfToken()}"; var _sc_version_tag = "${version_tag}";</script>`,
    },
    { css: `/static_assets/${version_tag}/saltcorn.css` },
    { script: `/static_assets/${version_tag}/saltcorn.js` },
  ];
  if (state.getConfig("page_custom_css", ""))
    headers.push({ style: state.getConfig("page_custom_css", "") });
  if (state.getConfig("page_custom_html", ""))
    headers.push({
      headerTag: state.getConfig("page_custom_html", ""),
    });
  const role = (req.user || {}).role_id || 10;

  return layout.wrap({
    title: page.title,
    brand: {},
    menu: [],
    currentUrl: "",
    alerts: [],
    body: contents,
    headers,
    role,
    req,
  });
};
