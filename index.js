const Workflow = require("@saltcorn/data/models/workflow");
const File = require("@saltcorn/data/models/file");
const Page = require("@saltcorn/data/models/page");
const View = require("@saltcorn/data/models/view");
const { eval_expression } = require("@saltcorn/data/models/expression");
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");
const { interpolate } = require("@saltcorn/data/utils");
const { domReady } = require("@saltcorn/markup/tags");

const { URL } = require("url");
const { generatePdf } = require("./html-pdf-node");
const fs = require("fs");
const path = require("path");

module.exports = {
  sc_plugin_api_version: 1,
  actions: {
    page_to_pdf: {
      configFields: async ({ table, mode }) => {
        let view_options = [];

        const pages = await Page.find();
        const headerFooterOptions = pages.map((p) => ({
          name: "Page:" + p.name,
          label: p.name + " [Page]",
        }));

        const entity_type_options = ["Page"];
        //if (mode !== "trigger") entity_type_options.push("Current URL");
        if (table) {
          entity_type_options.push("View");
          view_options = (await View.find({ table_id: table.id })).map(
            (v) => v.name
          );
          headerFooterOptions.push(
            ...view_options.map((vnm) => ({
              name: "View:" + vnm,
              label: vnm + " [View]",
            }))
          );
        }
        //entity_type_options.push("URL");

        return [
          {
            name: "entity_type",
            label: "Print what",
            type: "String",
            required: true,
            attributes: { options: entity_type_options },
          },
          {
            name: "page",
            label: "Page",
            type: "String",
            required: true,
            attributes: { options: pages.map((p) => p.name) },
            showIf: { entity_type: "Page" },
          },
          mode === "workflow"
            ? {
                name: "state_expr",
                label: "State expression",
                type: "String",
                sublabel:
                  "JavaScript expression for the page state, as an object. Example: <code>{id: book.id}</code>",
              }
            : {
                name: "statevars",
                label: "State variables",
                type: "String",
                sublabel:
                  "Which state variable to capture in printed page. Separate by comma.",
                showIf: { entity_type: "Page" },
              },
          {
            name: "view",
            label: "View",
            type: "String",
            required: true,
            attributes: { options: view_options },
            showIf: { entity_type: "View" },
          },
          {
            name: "url",
            label: "URL",
            type: "String",
            showIf: { entity_type: "URL" },
          },
          {
            name: "to_file",
            label: "Save to file",
            type: "Bool",
          },
          {
            name: "filename",
            label: "File name",
            type: "String",
            sublabel: "Default to page name + '.pdf' if left blank",
            showIf: { to_file: true },
          },

          {
            name: "format",
            label: "Format",
            type: "String",
            required: true,
            attributes: {
              options: ["A4", "Letter", "Legal", "PNG", "JPEG", "WebP"],
            },
          },
          {
            name: "css_selector",
            label: "CSS selector",
            type: "String",
            sublabel: "Optional. Element to print to image",
            showIf: { format: ["PNG", "JPEG", "WebP"] },
          },
          {
            name: "omit_bg",
            label: "Omit background",
            type: "Bool",
            showIf: { format: ["PNG", "JPEG", "WebP"] },
          },
          {
            name: "landscape",
            label: "Landscape",
            type: "Bool",
            showIf: { format: ["A4", "Letter", "Legal"] },
          },
          {
            name: "scale",
            label: "Scale",
            type: "Float",
            sublabel: "0.1-2",
            default: 1.0,
            attributes: { min: 0.1, max: 2, decimal_places: 1 },
            showIf: { format: ["A4", "Letter", "Legal"] },
          },
          {
            name: "marginLeft",
            label: "Left margin (cm)",
            type: "Float",
            default: 2.0,
            attributes: { min: 0.0, decimal_places: 1 },
            showIf: { format: ["A4", "Letter", "Legal"] },
          },
          {
            name: "marginRight",
            label: "Right margin (cm)",
            type: "Float",
            default: 2.0,
            attributes: { min: 0.0, decimal_places: 1 },
            showIf: { format: ["A4", "Letter", "Legal"] },
          },
          {
            name: "marginTop",
            label: "Top margin (cm)",
            type: "Float",
            default: 2.0,
            attributes: { min: 0.0, decimal_places: 1 },
            showIf: { format: ["A4", "Letter", "Legal"] },
          },
          {
            name: "marginBottom",
            label: "Bottom margin (cm)",
            type: "Float",
            default: 2.0,
            attributes: { min: 0.0, decimal_places: 1 },
            showIf: { format: ["A4", "Letter", "Legal"] },
          },
          {
            name: "header",
            label: "Header",
            type: "String",
            attributes: { options: headerFooterOptions },
            showIf: { format: ["A4", "Letter", "Legal"] },
          },
          {
            name: "footer",
            label: "Footer",
            type: "String",
            attributes: { options: headerFooterOptions },
            showIf: { format: ["A4", "Letter", "Legal"] },
          },
          {
            name: "footer_height",
            label: "Footer height (cm)",
            type: "Integer",
            showIf: {
              format: ["A4", "Letter", "Legal"],
            },
          },
          {
            name: "page_numbers",
            label: "Page numbers",
            type: "Bool",
            showIf: { format: ["A4", "Letter", "Legal"] },
          },
          {
            name: "custom_page_number_format",
            label: "Custom format",
            sublabel:
              '<a target="_blank" href="https://pptr.dev/api/puppeteer.pdfoptions#headertemplate">Puppeteer PDF footerTemplate</a>',
            type: "String",
            showIf: { format: ["A4", "Letter", "Legal"], page_numbers: true },
          },
        ];
      },
      run: async ({ row, mode, referrer, user, req, table, configuration }) => {
        const {
          page,
          entity_type,
          url,
          view,
          statevars,
          state_expr,
          to_file,
          filename,
          landscape,
          format,
          scale,
          marginLeft,
          marginRight,
          marginTop,
          marginBottom,
          css_selector,
          omit_bg,
          page_numbers,
          custom_page_number_format,
        } = configuration;
        if (!req)
          req = {
            user,
            getLocale() {
              return user?.language || "en";
            },
            csrfToken() {
              return "";
            },
            __(s) {
              return s;
            },
          };
        let qstate = {};
        let base;
        if (mode === "workflow") {
          base = getState().getConfig("base_url", "/");
          qstate = eval_expression(state_expr, row, user);
        } else {
          const xfer_vars = new Set(
            (statevars || "")
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s)
          );

          if (referrer) {
            const refUrl = new URL(referrer || "");

            for (const [name, value] of refUrl.searchParams) {
              if (xfer_vars.has(name)) qstate[name] = value;
            }
            base = refUrl.origin;
          } else base = getState().getConfig("base_url", "/");
          if (row) {
            xfer_vars.forEach((k) => {
              if (typeof row[k] !== "undefined") {
                qstate[k] = row[k];
              }
            });
          }
        }
        const toMargin = (x) =>
          typeof x === "undefined" || x === null ? "2cm" : `${x}cm`;
        let options = {
          css_selector,
          omitBackground: omit_bg,
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
        if (!["PNG", "JPEG", "WebP"].includes(options.format)) {
          if (page_numbers) {
            options.displayHeaderFooter = true;
            options.headerTemplate = " ";
            // originally '<div style="text-align: right;width: 297mm;font-size: 8px;"><span style="margin-right: 1cm"><span class="pageNumber"></span> of <span class="totalPages"></span></span></div>';
            // from https://github.com/puppeteer/puppeteer/issues/5345#issuecomment-613023667
            options.footerTemplate =
              custom_page_number_format ||
              '<div style="text-align: right;width: 100%;font-size: 10px;"><span style="margin-right: 1cm"><span class="pageNumber"></span></span></div>';
          }
          for (const hdrfoot of ["header", "footer"])
            if (configuration[hdrfoot]) {
              const [hdrEntType, vOrPname] = configuration[hdrfoot].split(":");
              const { html } = await get_contents({
                page: vOrPname,
                entity_type: hdrEntType,
                url,
                view: vOrPname,
                qstate,
                req,
                referrer,
                row,
                table,
                only_content: true,
              });
              options[hdrfoot + "Html"] = html;
            }

          if (configuration.footer_height)
            options["footerHeight"] = configuration["footer_height"];
        }
        const { html, default_name, min_role, domain } = await get_contents({
          page,
          entity_type,
          view,
          qstate,
          req,
          referrer,
          row,
          table,
          options,
        });

        //console.log(refUrl);
        //console.log(html);
        //fs.writeFileSync("pdfhtml.html", html);

        if (req.cookies?.["connect.sid"])
          options.cookie = {
            name: "connect.sid",
            value: req.cookies["connect.sid"],
            domain,
          };
        if (to_file)
          return await renderPdfToFile(
            html,
            req,
            default_name,
            options,
            base,
            row,
            filename,
            min_role
          );
        else return await renderPdfToStream(html, req, options, base);
      },
    },
  },
};

const get_contents = async ({
  page,
  entity_type,
  view,
  qstate,
  req,
  referrer,
  row,
  table,
  only_content,
  options,
}) => {
  let base, refUrl;
  if (referrer) {
    refUrl = new URL(referrer || "");
    base = refUrl.origin;
  } else base = getState().getConfig("base_url", "/");
  const domain = base.split("//")[1];

  if (!entity_type || entity_type === "Page") {
    const thePage = await Page.findOne({ name: page });

    const contents = await thePage.run(qstate, { res: {}, req });
    const html = await renderPage(
      contents,
      thePage.title,
      req,
      only_content,
      options
    );
    //console.log({ qstate, html });

    return {
      html,
      default_name: thePage.name,
      min_role: thePage.min_role,
      domain,
    };
  } else if (entity_type === "View") {
    const theView = await View.findOne({ name: view });
    if (row && table) qstate[table.pk_name] = row[table.pk_name];
    const contents = await theView.run(qstate, { res: {}, req });
    return {
      html: await renderPage(
        contents,
        theView.name,
        req,
        only_content,
        options
      ),
      default_name: theView.name,
      min_role: theView.min_role,
      domain,
    };
  }
};

const renderPdfToStream = async (html, req, options, base) => {
  let tmpFile = File.get_new_path() + ".html";
  const url = `${base}/files/serve/${path.basename(tmpFile)}`;
  getState().log(
    5,
    `pade-to-pdf to stream file=${tmpFile} url=${url} contents=${
      html?.substring ? html.substring(0, 20) : html
    }`
  );
  fs.writeFileSync(tmpFile, html);
  const pdfBuffer = await generatePdf({ url }, options);
  fs.unlinkSync(tmpFile);

  const mimetype = ["PNG", "JPEG", "WebP"].includes(options.format)
    ? `image/${options.format.toLowerCase()}`
    : "application/pdf";

  return {
    download: {
      blob: pdfBuffer.toString("base64"),
      //filename: thePage.name+".pdf",
      mimetype,
    },
  };
};

const ensure_final_slash = (s) => (s.endsWith("/") ? s : s + "/");

const renderPdfToFile = async (
  html,
  req,
  default_name,
  options,
  base,
  row,
  filename,
  min_role
) => {
  const the_filename =
    filename && interpolate && row
      ? interpolate(filename, row, req?.user)
      : filename || default_name + ".pdf";
  let tmpFile = File.get_new_path() + ".html";
  options.path = File.get_new_path(the_filename);
  fs.writeFileSync(tmpFile, html);
  //console.log("render html", html);
  
  await generatePdf(
    { url: `${ensure_final_slash(base)}files/serve/${path.basename(tmpFile)}` },
    options
  );
  fs.unlinkSync(tmpFile);
  const stats = fs.statSync(options.path);

  const file = await File.create({
    location: options.path,
    uploaded_at: new Date(),
    filename: the_filename,

    user_id: (req.user || {}).id,
    size_kb: Math.round(stats.size / 1024),
    mime_super: "application",
    mime_sub: "pdf",
    min_role_read: min_role,
  });
  return { goto: `/files/serve/${file.path_to_serve}`, target: "_blank" };
};


const renderPage = async (contents, pageTitle, req, only_content, options) => {
  const state = getState();
  const layout = state.getLayout(req.user);
  const role = (req.user || {}).role_id || 100;

  let htmlOut;
  if (only_content) {
    if (typeof contents === "string") htmlOut = contents;
    else {
      htmlOut = layout.renderBody({
        title: pageTitle,
        alerts: [],
        body: contents,
        role,
        req,
      });
    }
  } else {
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
        headerTag: `<script>var _sc_globalCsrf = "${req.csrfToken()}"; 
      var _sc_version_tag = "${version_tag}";      
      </script>`,
      },
      { css: `/static_assets/${version_tag}/saltcorn.css` },
      { script: `/static_assets/${version_tag}/saltcorn.js` },
      { scriptBody: domReady(`$('.accordion-collapse').addClass("show")`) },
    ];
    if (state.getConfig("page_custom_css", ""))
      headers.push({ style: state.getConfig("page_custom_css", "") });
    if (state.getConfig("page_custom_html", ""))
      headers.push({
        headerTag: state.getConfig("page_custom_html", ""),
      });
    let useContents = contents;
    if (options?.headerHtml || options?.footerHtml) {
      const bodyHtml = layout.renderBody({
        title: pageTitle,
        alerts: [],
        body: contents,
        role,
        req,
      });
      //https://medium.com/@Idan_Co/the-ultimate-print-html-template-with-header-footer-568f415f6d2a
      if (options.footerHeight)
        useContents = `<table>
      <thead>
        <tr><td>
          <div class="header">${options?.headerHtml || ""}</div>          
        </td></tr>
      </thead>
      <tbody>
        <tr><td>
          <div>${bodyHtml}</div>
        </td></tr>
      </tbody>
      <tfoot>
        <tr><td>
          <div class="page2pdf-footer-space">&nbsp;</div>
        </td></tr>
      </tfoot>
    </table>   
    <div class="page2pdf-footer">${options?.footerHtml || ""}</div>
    <style>      
      .page2pdf-footer, .page2pdf-footer-space {
        height: ${options.footerHeight || "3"}cm;        
      }     
      .page2pdf-footer {
        width: 100%;
        position: fixed;
        bottom: 0;
      }
    </style>`;
      else
        useContents = `<table>
  <thead>
    <tr><td>
      <div class="header">${options?.headerHtml || ""}</div>
    </td></tr>
  </thead>
  <tbody>
    <tr><td>
      <div class="content">${bodyHtml}</div>
    </td></tr>
  </tbody>
  <tfoot>
    <tr><td>
      <div class="footer">${options?.footerHtml || ""}</div>
    </td></tr>
  </tfoot>
</table>`;
    }
    htmlOut = layout.wrap({
      title: pageTitle,
      brand: {},
      menu: [],
      currentUrl: "",
      alerts: [],
      body: useContents,
      headers,
      role,
      req,
    });
  }
  const html1 = htmlOut.replaceAll(
    `<img src="../files/serve`,
    `<img src="/files/serve`
  );
  return html1; // .replace("<head>", `<head><base href="${baseUrl}">`);
};

const executablePath = fs.existsSync("/usr/bin/chromium-browser")
  ? "/usr/bin/chromium-browser"
  : fs.existsSync("/usr/bin/chromium")
  ? "/usr/bin/chromium"
  : fs.existsSync(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    )
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : undefined;
