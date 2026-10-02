declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  type Plugin = (service: TurndownService) => void;
  const plugin: { gfm: Plugin; tables: Plugin; strikethrough: Plugin; taskListItems: Plugin };
  export default plugin;
}
