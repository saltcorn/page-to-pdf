const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Page = require("@saltcorn/data/models/page");
const { URL } = require("url");

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
        const state = {};
        for (const [name, value] of new URL(referrer || "").searchParams) {
          state[name] = value;
        }
        console.log(state);
        const thePage = await Page.findOne({ name: page });
        if (thePage) {
          const contents = await thePage.run(state, { res: {}, req });
          console.log(contents);
        }
      },
    },
  },
};
