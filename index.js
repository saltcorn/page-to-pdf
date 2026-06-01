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
  contents: [
    "Renders a Saltcorn View or Page to PDF (or PNG/JPEG) using a headless Chromium browser.",
    "Use this plugin whenever a task requires generating a PDF — invoices, reports, certificates, etc.",
    "Do NOT use run_bash_script or any shell command for PDF generation; use this action instead.",
    "",
    "CRITICAL — print page type: the print page MUST be a standard Saltcorn layout page",
    "(page_type 'layout' or omitted, layout built from Saltcorn segments such as cards,",
    "fields, embed-view, etc.). NEVER use page_type 'html', a raw HTML string layout, or",
    "an html_string segment — page_to_pdf cannot render HTML-backed pages and will throw",
    "'unknown layout segment' at runtime. This applies at both planning time and when",
    "implementing the page. If you find yourself writing <!doctype>, <html>, <head>, or",
    "<body> as the page content, stop — you are building the wrong thing.",
    "",
    "Action: page_to_pdf",
    "Key configuration fields:",
    "- entity_type: what to render. Use 'Page' for all PDF generation — a dedicated print page",
    "  gives full layout control and is the correct approach for invoices, reports, and certificates.",
    "  'View' renders a raw table view and should NOT be used for PDF output.",
    "  'URL' renders an arbitrary URL.",
    "- page: name of the Page to render (when entity_type = 'Page'). The page MUST already exist",
    "  before the workflow runs — plan a separate page-creation task that the workflow depends on.",
    "- view: name of the View to render (when entity_type = 'View'). Avoid for PDF generation.",
    "- state_expr: (workflow mode only) JavaScript expression returning the state object passed to",
    "  the page. Example: {id: row.id} passes the current row's primary key to the print page.",
    "- to_file: set true to save the generated PDF to the Saltcorn file store instead of",
    "  streaming it to the browser. Required when the PDF must be attached to an email or",
    "  linked to a record's File field.",
    "- filename: name for the saved file. Supports {{field}} interpolation from the workflow context.",
    "  Example: invoice-{{new_invoice_id}}.pdf. Defaults to the page name + '.pdf'.",
    "  IMPORTANT: uses Saltcorn's double-brace {{field}} syntax — single braces {field} are NOT replaced.",
    "- format: paper size — 'A4' (default), 'Letter', 'Legal' — or image format 'PNG'/'JPEG'.",
    "",
    "REQUIRED planning step: every plan that uses page_to_pdf MUST include a dedicated print PAGE",
    "task (task_type feature, creates a Saltcorn Page — NOT a View). This page contains all the",
    "content that should appear in the PDF (e.g. invoice header, line items, totals). It can embed",
    "existing Show views to display row data. This page task MUST appear before the workflow task",
    "in the plan and the workflow task MUST list it in depends_on.",
    "Name the page clearly, e.g. 'invoice_print'. Do NOT create a Show view for this purpose.",
    "The print page MUST use a standard Saltcorn layout (page_type 'layout' or omitted).",
    "NEVER use page_type 'html' or a raw HTML string — page_to_pdf will throw 'unknown",
    "layout segment'. Always build the page with Saltcorn layout segments (cards, fields,",
    "embed-view, etc). Do not output HTML to the conversation.",
    "",
    "Workflow usage pattern for generating and saving a PDF for a row:",
    "1. Plan a print PAGE task (e.g. 'invoice_print') — a Saltcorn Page (not a View) that embeds",
    "   the relevant Show view and displays all invoice data for printing. When embedding a Show",
    "   view in the page, use state 'shared' so the page's URL state (e.g. id) is forwarded to",
    '   the view: {"type":"view","view":"invoices_show","state":"shared"}. A Show view',
    "   that does not receive an id displays 'No row selected' and will produce a blank PDF.",
    "   CRITICAL: a print page must ONLY embed Show or List views — NEVER embed an Edit view.",
    "   Edit views render form inputs, save buttons, and date pickers that are wrong for a PDF.",
    "   If you need to display related rows (e.g. line items), embed a List or Show view for",
    "   that related table, not an Edit view.",
    "2. In the workflow task, add a page_to_pdf step with entity_type='Page',",
    "   page='invoice_print', state_expr='{id: new_invoice_id}', to_file=true,",
    "   filename='invoice-{{new_invoice_id}}.pdf'.",
    "   IMPORTANT: filename uses Saltcorn double-brace {{field}} syntax. The field name must",
    "   match a key in the workflow context (e.g. new_invoice_id if the insert step returns",
    "   that key). Single braces {field} are NOT replaced and will appear literally in the filename.",
    "3. After the page_to_pdf step completes, the workflow context automatically contains:",
    "   - pdf_file_id: the database id of the saved PDF file",
    "   - pdf_path_to_serve: the serve path of the saved PDF file",
    "   No extra run_js_code or TableQuery step is needed to look up the file.",
    "4. To link the saved PDF to a record's File field, add a modify_row step immediately",
    "   after page_to_pdf that sets the File field using pdf_file_id from the context.",
    "   Use where='Database', select_table='invoices', query='{id: row.id}',",
    "   row_expr='{pdf_field: pdf_file_id}'.",
    "5. To email the PDF, use the send_email action and reference pdf_file_id from the context.",
    "",
    "CRITICAL — step ordering: page_to_pdf renders the page at the moment it runs, using only",
    "the database rows that exist at that point. If the PDF embeds a view that shows related rows",
    "(e.g. a List view of line items or billable hours), those rows MUST already be inserted before",
    "page_to_pdf runs — otherwise the list will be empty in the PDF even though it shows correctly",
    "in the browser (where the rows exist by the time you open the page).",
    "Rule: always place the page_to_pdf step AFTER every insert/update step that writes data",
    "displayed in the PDF. The correct order is:",
    "  1. Insert parent row",
    "  2. Insert all child rows (line items, related records, etc.)",
    "  3. Update parent row with computed totals",
    "  4. page_to_pdf  ← only here, after all data is committed",
    "  5. send_email / link file to record  (optional — place page_to_pdf directly before",
    "     send_email if one exists, or as the last data step if there is no email step)",
    "Never place page_to_pdf immediately after creating the parent row if child rows are inserted",
    "in later steps.",
  ].join("\n"),
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

        entity_type_options.push("URL");

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
          {
            name: "viewport_width",
            label: "Viewport width (px)",
            type: "Integer",
            showIf: { entity_type: "URL", format: ["PNG", "JPEG", "WebP"] },
          },
          {
            name: "viewport_height",
            label: "Viewport height (px)",
            type: "Integer",
            showIf: { entity_type: "URL", format: ["PNG", "JPEG", "WebP"] },
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
          viewport_width,
          viewport_height,
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
          qstate = eval_expression(state_expr || "{}", row, user);
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
          viewport_height: entity_type === "URL" ? viewport_height : undefined,
          viewport_width: entity_type === "URL" ? viewport_width : undefined,
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
          url:
            entity_type === "URL"
              ? interpolate(url, row || {}, user, "page_to_pdf URL")
              : undefined,
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
        if (to_file) {
          const result = await renderPdfToFile(
            html,
            req,
            default_name,
            options,
            base,
            row,
            filename,
            min_role,
            entity_type === "URL"
              ? interpolate(url, row || {}, user, "page_to_pdf URL")
              : undefined
          );
          if (mode === "workflow")
            return {
              pdf_file_id: result.pdf_file_id,
              pdf_path_to_serve: result.pdf_path_to_serve,
            };
          return result;
        } else
          return await renderPdfToStream(
            html,
            req,
            options,
            base,
            entity_type === "URL"
              ? interpolate(url, row || {}, user, "page_to_pdf URL")
              : undefined
          );
      },
    },
  },
};

const get_contents = async ({
  page,
  entity_type,
  view,
  url,
  qstate,
  req,
  referrer,
  row,
  table,
  only_content,
  options,
}) => {
  if (url) return {};
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

const renderPdfToStream = async (html, req, options, base, url_in) => {
  let tmpFile;
  if (!url_in) {
    tmpFile = File.get_new_path() + ".html";
    fs.writeFileSync(tmpFile, html);
    //sets the user id, needed to serve
    await File.create({
      location: tmpFile,
      uploaded_at: new Date(),
      filename: path.basename(tmpFile),

      user_id: (req.user || {}).id,
      size_kb: 13, // not needed
      mime_super: "text",
      mime_sub: "html",
      min_role_read: 1,
    });
  }
  const url =
    url_in ||
    `${ensure_final_slash(base)}files/serve/${path.basename(tmpFile)}`;
  getState().log(
    5,
    `pade-to-pdf to stream file=${tmpFile} url=${url} contents=${
      html?.substring ? html.substring(0, 20) : html
    }`
  );
  if (url_in && options.cookie && !options.cookie.domain) {
    try {
      options.cookie.domain = new URL(url_in).hostname;
    } catch (e) {}
  }
  const pdfBuffer = await generatePdf({ url }, options);
  if (tmpFile) fs.unlinkSync(tmpFile);

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
  min_role,
  url
) => {
  const the_filename =
    filename && interpolate
      ? interpolate(filename, row || {}, req?.user)
      : filename || default_name + ".pdf";
  options.path = File.get_new_path(the_filename);
  let tmpFile;
  if (!url) {
    tmpFile = File.get_new_path() + ".html";

    fs.writeFileSync(tmpFile, html);

    //sets the user id, needed to serve
    await File.create({
      location: tmpFile,
      uploaded_at: new Date(),
      filename: path.basename(tmpFile),

      user_id: (req.user || {}).id,
      size_kb: 13, // not needed
      mime_super: "text",
      mime_sub: "html",
      min_role_read: min_role,
    });
  }

  //console.log("render html", html);
  await generatePdf(
    url
      ? { url, noCookie: true }
      : {
          url: `${ensure_final_slash(base)}files/serve/${path.basename(
            tmpFile
          )}`,
        },
    options
  );
  if (tmpFile) fs.unlinkSync(tmpFile);

  const file = await File.create({
    location: options.path,
    uploaded_at: new Date(),
    filename: the_filename,

    user_id: (req.user || {}).id,
    size_kb: 13,
    mime_super: "application",
    mime_sub: "pdf",
    min_role_read: min_role,
  });
  return {
    goto: `/files/serve/${file.path_to_serve}`,
    target: "_blank",
    pdf_file_id: file.id,
    pdf_path_to_serve: file.path_to_serve,
  };
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
