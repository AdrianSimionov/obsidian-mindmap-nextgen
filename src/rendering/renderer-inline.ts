import { Editor, ItemView, parseYaml, TFile } from "obsidian";
import { Markmap, deriveOptions } from "markmap-view";
import { IMarkmapJSONOptions, IMarkmapOptions, INode } from "markmap-common";
import R, { difference, pick } from "ramda";
import { fields, match, variantModule } from "variant";

import { globalSettings$, PluginSettings } from "src/filesystem";
import { cssClasses, FRONT_MATTER_REGEX } from "src/constants";
import { toggleBodyClass } from "src/rendering/style-tools";
import readMarkdown from "./renderer-common";
import { Callbag } from "src/utilities"
import { Source } from "callbag"


type Frontmatter = Partial<{
  markmap: Partial<{
    highlight: boolean;
  }>
}>
const getFrontmatter1 = (file: TFile) =>
  new Promise<Frontmatter>(resolve =>
    app.fileManager.processFrontMatter(file, resolve));
const getFrontmatter2 = (editor: Editor) => {
  const str = FRONT_MATTER_REGEX.exec(editor.getValue())?.[0].slice(4, -4);
  return str && parseYaml(str)
};

toggleBodyClass("highlight", cssClasses.highlight)
app.workspace.on("file-open", file =>
  file?.extension === 'md' &&
  getFrontmatter1(file).then(updateFrontmatterHighlight))
app.workspace.on("editor-change", (editor, { file }) =>
  file?.extension === 'md' &&
  updateFrontmatterHighlight(getFrontmatter2(editor)))


async function updateFrontmatterHighlight(frontmatter: Frontmatter | null) {
  const highlight = frontmatter?.markmap?.highlight;
  const classList = app.workspace.activeLeaf!.containerEl.parentElement!.classList;

  if (typeof highlight !== 'boolean') {
    classList.remove(cssClasses.highlight)
    classList.remove(cssClasses.highlightOff) }
  if (highlight === true) {
    classList.add(cssClasses.highlight)
    classList.remove(cssClasses.highlightOff) }
  if (highlight === false) {
    classList.add(cssClasses.highlightOff)
    classList.remove(cssClasses.highlight) }
}

export interface FrontmatterSettings extends Omit<PluginSettings, "screenshotTextColorEnabled" | "titleAsRootNode"> {
  color: IMarkmapJSONOptions["color"]
};


export type InlineRenderer = ReturnType<typeof InlineRenderer>;
export function InlineRenderer(markdown: string, containerEl: HTMLDivElement, settings: PluginSettings) {
  const { markmap } = initialise(containerEl);
  let hasFit = false;

  const { root, frontmatterSettings } = readMarkdown(markdown);

  const codeblockSettings$ = Callbag.of<Partial<FrontmatterSettings>[]>(frontmatterSettings)

  const { combine, map, subscribe, dropRepeats, pairwise, startWith, sampleCombine } = Callbag;

  const settings$ = Callbag.pipe(
    combine(codeblockSettings$, fileSettings$ as unknown as Source<FrontmatterSettings>, globalSettings$),
    map(([codeblock, file, global]): FrontmatterSettings =>
      ({ ...global, ...file, ...codeblock })),
    dropRepeats(),
    startWith({})
  )

  const first = <A, B>([a, b]: [A, B]) => a

  const whatChanged = <T extends {}>([previous, latest]: [T, T]) =>
    R.map(first, difference(Object.entries(latest), Object.entries(previous))) as (keyof T)[]

  const whatChanged$ = Callbag.pipe(
    settings$,
    pairwise,
    map(whatChanged)
  )

  const markmapOptions$ = Callbag.pipe(
    settings$,
    map(markmapOptions)
  )
  
  Callbag.pipe(
    whatChanged$,
    sampleCombine(settings$),
    subscribe(([changes, settings]) => {
      let willRender = false;

      // Need to get these options from somewhere
      const options = markmapOptions(settings);
      const optionsChanges: Partial<IMarkmapJSONOptions> = {};

      changes.forEach(change => {

        match(renderStrategies[change], {
          css({ fn }) {
            fn(containerEl, settings, change);
          },
          cssAndMarkmap({ fn }) {
            fn(containerEl, settings, change);
            willRender = true;
          },
          markmap(){
            willRender = true;
          },
          setOptions(){
            optionsChanges[change] = settings[change];

            // We definitely will have simultaneous changes.  On first render! ALL settings update at once.
          }
        })

        //  ^^ In all this mess ^^
        // We are trying to
        // A: establish need for setOptions or setData
        // B: Do any other tasks required

        // Some operations should only happen if not calling setData

        // We create the options in the normal way
        // Then the above strategies tell us whether we need to setData or setOptions

      })

      if (willRender)
        return markmap.setData(root, { options, ...optionsChanges });
      
      if (Object.keys(options).length > 0)
        markmap.setOptions({ options, ...optionsChanges })
    })
  )

  type RenderStrategy = "setData" | "setOptions" | "css"
  const renderStrategies: Record<keyof FrontmatterSettings, RenderStrategy> = {
    animationDuration: "setOptions",
    colorFreezeLevel: "setData",
    initialExpandLevel: "setData",
    
    splitDirection: "setData",
    nodeMinHeight: "setData",
    spacingVertical: "setData",
    spacingHorizontal: "setData",
    paddingX: "setData",
    
    coloring: "setData",
    defaultColor: "setData",
    depth1Color: "setData",
    depth2Color: "setData",
    depth3Color: "setData",
  
    maxWidth: "setData",
    screenshotBgColor: "setData",
    screenshotBgStyle: "setData",
    screenshotTextColor: "setData",
    color: "setData",
    
    depth1Thickness: "css",
    depth2Thickness: "css",
    depth3Thickness: "css",
    defaultThickness: "css",
    
    highlight: "css",
    lineHeight: "css",

    useThemeFont: ["css", "setData"]
  }


  return { fit, containerEl }

  function fit() {
    if (hasFit) return;
    markmap.fit();
    hasFit = true;
  }


  function markmapOptions(settings: FrontmatterSettings): Partial<IMarkmapOptions> {
    const derived = deriveOptions(pick(["color", "colorFreezeLevel"], settings));
    const color = {
      depth: depthColoring(settings.color),
      branch: derived.color!,
      single: () => settings.defaultColor
    }[ settings.coloring ];
    
    return {
      autoFit: false,
      color,
      duration: settings.animationDuration,
      embedGlobalCSS: true,
      fitRatio: 1,
      ...pick([
        "maxWidth",
        "nodeMinHeight",
        "paddingX",
        "spacingHorizontal",
        "spacingVertical",
        "initialExpandLevel"
      ], settings)
    }
  }

  function depthColoring(frontmatterColors?: string[]) {
    return ({ depth }: INode) => {
      depth = depth!;
      if (frontmatterColors?.length)
        return frontmatterColors[depth % frontmatterColors.length]

      const colors = [settings.depth1Color, settings.depth2Color, settings.depth3Color];

      return depth < 3 ?
        colors[depth] :
        settings.defaultColor
    };
  }
}

function initialise(containerEl: ItemView["containerEl"]) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const markmap = Markmap.create(svg, {});

  containerEl.append(svg);

  return { svg, markmap };
}
