const Workflow = require("@saltcorn/data/models/workflow");
const File = require("@saltcorn/data/models/file");
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
          {
            name: "to_file",
            label: "Save to file",
            type: "Bool",
          },
          {
            name: "landscape",
            label: "Landscape",
            type: "Bool",
          },
          {
            name: "scale",
            label: "Scale",
            type: "Float",
            sublabel: "0.1-2",
            default: 1.0,
            attributes: { min: 0.1, max: 2, decimal_places: 1 },
          },
          {
            name: "format",
            label: "Format",
            type: "String",
            required: true,
            attributes: { options: ["A4", "Letter", "Legal"] },
          },
          {
            name: "marginLeft",
            label: "Left margin (cm)",
            type: "Float",
            default: 2.0,
            attributes: { min: 0.0, decimal_places: 1 },
          },
          {
            name: "marginRight",
            label: "Right margin (cm)",
            type: "Float",
            default: 2.0,
            attributes: { min: 0.0, decimal_places: 1 },
          },
          {
            name: "marginTop",
            label: "Top margin (cm)",
            type: "Float",
            default: 2.0,
            attributes: { min: 0.0, decimal_places: 1 },
          },
          {
            name: "marginBottom",
            label: "Bottom margin (cm)",
            type: "Float",
            default: 2.0,
            attributes: { min: 0.0, decimal_places: 1 },
          },
        ];
      },
      run: async ({
        row,
        referrer,
        req,
        configuration: {
          page,
          statevars,
          to_file,
          landscape,
          format,
          scale,
          marginLeft,
          marginRight,
          marginTop,
          marginBottom,
        },
      }) => {
        const qstate = {};
        const xfer_vars = new Set(
          (statevars || "")
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s)
        );
        let base;

        if (referrer) {
          const refUrl = new URL(referrer || "");

          for (const [name, value] of refUrl.searchParams) {
            if (xfer_vars.has(name)) qstate[name] = value;
          }
          base = refUrl.origin;
        } else base = getState().getConfig("base_url", "/");
        if (row) {
          xfer_vars.forEach((k) => {
            if (typeof row[k] !== undefined) {
              qstate[k] = row[k];
            }
          });
        }
        const thePage = await Page.findOne({ name: page });
        const toMargin = (x) =>
          typeof x === "undefined" || x === null ? "2cm" : `${x}cm`;
        if (thePage) {
          const contents = await thePage.run(qstate, { res: {}, req });
          const html = await renderPage(contents, thePage, base, req);
          //console.log(refUrl);
          console.log(html);

          const executablePath = fs.existsSync("/usr/bin/chromium-browser")
            ? "/usr/bin/chromium-browser"
            : fs.existsSync("/usr/bin/chromium")
            ? "/usr/bin/chromium"
            : undefined;

          let options = {
            format: format || "A4",
            landscape: !!landscape,
            scale: +(scale || 1.0),
            margin: {
              top: toMargin(marginTop),
              bottom: toMargin(marginBottom),
              left: toMargin(marginLeft),
              right: toMargin(marginRight),
            },
            executablePath,
          };
          if (to_file)
            return await renderPdfToFile(html, req, thePage, options);
          else return await renderPdfToStream(html, req, thePage, options);
        } else {
          return { error: `Page not found: ${page}` };
        }
      },
    },
  },
};

const renderPdfToStream = async (html, req, thePage, options) => {
  const pdfBuffer = await generatePdf({ content: html }, options);

  return {
    download: {
      blob: pdfBuffer.toString("base64"),
      //filename: thePage.name+".pdf",
      mimetype: "application/pdf",
    },
  };
};
const renderPdfToFile = async (html, req, thePage, options) => {
  options.path = File.get_new_path();
  await generatePdf({ content: html }, options);
  const stats = fs.statSync(options.path);
  const file = await File.create({
    location: options.path,
    uploaded_at: new Date(),
    filename: thePage.name + ".pdf",
    user_id: (req.user || {}).id,
    size_kb: Math.round(stats.size / 1024),
    mime_super: "application",
    mime_sub: "pdf",
    min_role_read: thePage.min_role,
  });
  return { goto: `/files/serve/${file.id}`, target: "_blank" };
};
const renderPage = async (contents, page, baseUrl, req) => {
  const state = getState();
  const layout = state.getLayout(req.user);
  const version_tag = db.connectObj.version_tag;
  let state_headers = [];
  if (Array.isArray(state.headers)) {
    state_headers = state.headers;
  } else
    for (const hs of Object.values(state.headers)) {
      state_headers.push(...hs);
    }
  const headers = [
    ...state_headers,
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

  const htmlOut = layout.wrap({
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
  return htmlOut.replace("<head>", `<head><base href="${baseUrl}">`);
};
