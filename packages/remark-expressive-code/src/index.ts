import type { Plugin, Transformer, VFileWithOutput } from 'unified'
import type { Root, Parent, Code, HTML } from 'mdast'
import {
	BundledShikiTheme,
	loadShikiTheme,
	ExpressiveCode,
	ExpressiveCodeConfig,
	ExpressiveCodeTheme,
	ExpressiveCodeBlockOptions,
	ExpressiveCodeBlock,
	ExpressiveCodeThemeInput,
} from 'expressive-code'
import type { Element } from 'expressive-code/hast'
import { toHtml, visit } from 'expressive-code/hast'

export * from 'expressive-code'

export type RemarkExpressiveCodeOptions = Omit<ExpressiveCodeConfig, 'themes'> & {
	/**
	 * The color themes that should be available for your code blocks.
	 *
	 * CSS variables will be generated for all themes, allowing to select the theme to display
	 * using CSS. If you specify one dark and one light theme, a `prefers-color-scheme` media query
	 * will also be generated by default. You can customize this to match your site's needs
	 * through the `useDarkModeMediaQuery` and `themeCssSelector` options.
	 *
	 * The following item types are supported in this array:
	 * - any theme name bundled with Shiki (e.g. `dracula`)
	 * - any theme object compatible with VS Code or Shiki (e.g. imported from an NPM theme package)
	 * - any ExpressiveCodeTheme instance (e.g. using `ExpressiveCodeTheme.fromJSONString(...)`
	 *   to load a custom JSON/JSONC theme file yourself)
	 *
	 * Defaults to `['github-dark', 'github-light']`, two themes bundled with Shiki.
	 */
	themes?: ThemeObjectOrShikiThemeName[] | undefined
	/**
	 * The number of spaces that should be used to render tabs. Defaults to 2.
	 *
	 * Any tabs found in code blocks in your markdown/MDX documents will be replaced
	 * with the specified number of spaces. This ensures that the code blocks are
	 * rendered consistently across browsers and platforms.
	 *
	 * If you want to preserve tabs in your code blocks, set this option to 0.
	 */
	tabWidth?: number | undefined
	/**
	 * This optional function provides support for multi-language sites by allowing you
	 * to customize the locale used for a given code block.
	 *
	 * If the function returns `undefined`, the default locale provided in the
	 * Expressive Code configuration is used.
	 */
	getBlockLocale?: (({ input, file }: { input: ExpressiveCodeBlockOptions; file: VFileWithOutput<null> }) => string | undefined | Promise<string | undefined>) | undefined
	/**
	 * This optional function allows you to customize how `ExpressiveCodeBlock`
	 * instances are created from code blocks found in the Markdown document.
	 *
	 * The function is called with an object containing the following properties:
	 * - `input`: Block data for the `ExpressiveCodeBlock` constructor.
	 * - `file`: A `VFile` instance representing the Markdown document.
	 *
	 * The function is expected to return an `ExpressiveCodeBlock` instance
	 * or a promise resolving to one.
	 */
	customCreateBlock?: (({ input, file }: { input: ExpressiveCodeBlockOptions; file: VFileWithOutput<null> }) => ExpressiveCodeBlock | Promise<ExpressiveCodeBlock>) | undefined
	/**
	 * This advanced option allows you to influence the rendering process by creating
	 * your own `ExpressiveCode` instance or processing the base styles and JS modules
	 * added to every page.
	 *
	 * The return value will be cached and used for all code blocks on the site.
	 */
	customCreateRenderer?: ((options: RemarkExpressiveCodeOptions) => Promise<RemarkExpressiveCodeRenderer> | RemarkExpressiveCodeRenderer) | undefined
}

export type ThemeObjectOrShikiThemeName = BundledShikiTheme | ExpressiveCodeTheme | ExpressiveCodeThemeInput

export type RemarkExpressiveCodeDocument = {
	/**
	 * The full path to the source file containing the code block.
	 */
	sourceFilePath?: string | undefined
}

export type RemarkExpressiveCodeRenderer = {
	ec: ExpressiveCode
	baseStyles: string
	themeStyles: string
	jsModules: string[]
}

/**
 * Creates an `ExpressiveCode` instance using the given `options`,
 * including support to load themes bundled with Shiki by name.
 *
 * Returns the created `ExpressiveCode` instance together with the base styles and JS modules
 * that should be added to every page.
 */
export async function createRenderer(options: RemarkExpressiveCodeOptions = {}): Promise<RemarkExpressiveCodeRenderer> {
	// Transfer deprecated `theme` option to `themes` without triggering the deprecation warning
	const deprecatedOptions: Omit<RemarkExpressiveCodeOptions, 'theme'> & { theme?: ThemeObjectOrShikiThemeName | ThemeObjectOrShikiThemeName[] | undefined } = options
	if (deprecatedOptions.theme && !options.themes) {
		options.themes = Array.isArray(deprecatedOptions.theme) ? deprecatedOptions.theme : [deprecatedOptions.theme]
		delete deprecatedOptions.theme
	}
	const { themes, ...ecOptions } = options

	const loadedThemes =
		themes &&
		(await Promise.all(
			(Array.isArray(themes) ? themes : [themes]).map(async (theme) => {
				const mustLoadTheme = theme !== undefined && !(theme instanceof ExpressiveCodeTheme)
				const optLoadedTheme = mustLoadTheme ? new ExpressiveCodeTheme(typeof theme === 'string' ? await loadShikiTheme(theme) : theme) : theme
				return optLoadedTheme
			})
		))
	const ec = new ExpressiveCode({
		themes: loadedThemes,
		...ecOptions,
	})
	const baseStyles = await ec.getBaseStyles()
	const themeStyles = await ec.getThemeStyles()
	const jsModules = await ec.getJsModules()

	return {
		ec,
		baseStyles,
		themeStyles,
		jsModules,
	}
}

/**
 * @deprecated Please update your project to use the new package `rehype-expressive-code`,
 * which includes performance improvements and also works with current popular site generators.
 */
const remarkExpressiveCode: Plugin<[RemarkExpressiveCodeOptions] | unknown[], Root> = (...settings) => {
	const options: RemarkExpressiveCodeOptions = settings[0] ?? {}
	const { tabWidth = 2, getBlockLocale, customCreateRenderer, customCreateBlock } = options

	let asyncRenderer: Promise<RemarkExpressiveCodeRenderer> | RemarkExpressiveCodeRenderer | undefined

	const renderBlockToHtml = async ({
		codeBlock,
		renderer,
		addedStyles,
		addedJsModules,
	}: {
		codeBlock: ExpressiveCodeBlock
		renderer: RemarkExpressiveCodeRenderer
		addedStyles: Set<string>
		addedJsModules: Set<string>
	}): Promise<string> => {
		const { ec, baseStyles, themeStyles, jsModules } = renderer

		// Try to render the current code block
		const { renderedGroupAst, styles } = await ec.render(codeBlock)

		// Collect any style and script elements that we need to add to the output
		const extraElements: Element[] = []
		const stylesToPrepend: string[] = []

		// Add any styles that we haven't added yet
		// - Base styles
		if (baseStyles && !addedStyles.has(baseStyles)) {
			addedStyles.add(baseStyles)
			stylesToPrepend.push(baseStyles)
		}
		// - Theme styles
		if (themeStyles && !addedStyles.has(themeStyles)) {
			addedStyles.add(themeStyles)
			stylesToPrepend.push(themeStyles)
		}
		// - Group-level styles
		for (const style of styles) {
			if (addedStyles.has(style)) continue
			addedStyles.add(style)
			stylesToPrepend.push(style)
		}
		// Combine all styles we collected (if any) into a single style element
		if (stylesToPrepend.length) {
			extraElements.push({
				type: 'element',
				tagName: 'style',
				properties: {},
				children: [{ type: 'text', value: [...stylesToPrepend].join('') }],
			})
		}

		// Create script elements for all JS modules we haven't added yet
		jsModules.forEach((moduleCode) => {
			if (addedJsModules.has(moduleCode)) return
			addedJsModules.add(moduleCode)
			extraElements.push({
				type: 'element',
				tagName: 'script',
				properties: { type: 'module' },
				children: [{ type: 'text', value: moduleCode }],
			})
		})

		// Prepend any extra elements to the children of the renderedGroupAst wrapper,
		// which keeps them inside the wrapper and reduces the chance of CSS issues
		// caused by selectors like `* + *` on the parent level
		renderedGroupAst.children.unshift(...extraElements)

		// Render the group AST to HTML
		const htmlContent = toHtml(renderedGroupAst)

		return htmlContent
	}

	const transformer: Transformer<Root, Root> = async (tree, file) => {
		const nodesToProcess: [Parent, Code][] = []

		visit(tree, 'code', (code, index, parent) => {
			if (index === null || !parent) return
			nodesToProcess.push([parent, code])
		})

		if (nodesToProcess.length === 0) return

		// We found at least one code node, so we need to ensure our renderer is available
		// and wait for its initialization if necessary
		if (asyncRenderer === undefined) {
			asyncRenderer = (customCreateRenderer ?? createRenderer)(options)
		}
		const renderer = await asyncRenderer

		const addedStyles = new Set<string>()
		const addedJsModules = new Set<string>()

		for (let groupIndex = 0; groupIndex < nodesToProcess.length; groupIndex++) {
			const [parent, code] = nodesToProcess[groupIndex]

			// Normalize the code coming from the Markdown/MDX document
			let normalizedCode = code.value
			if (tabWidth > 0) normalizedCode = normalizedCode.replace(/\t/g, ' '.repeat(tabWidth))

			// Build the ExpressiveCodeBlockOptions object that we will pass either
			// to the ExpressiveCodeBlock constructor or the customCreateBlock function
			const input: ExpressiveCodeBlockOptions = {
				code: normalizedCode,
				language: code.lang || '',
				meta: code.meta || '',
				parentDocument: {
					sourceFilePath: file.path,
					documentRoot: tree,
					positionInDocument: {
						groupIndex,
						totalGroups: nodesToProcess.length,
					},
				},
			}

			// Allow the user to customize the locale for this code block
			if (getBlockLocale) {
				input.locale = await getBlockLocale({ input: input, file })
			}

			// Allow the user to customize the ExpressiveCodeBlock instance
			const codeBlock = customCreateBlock ? await customCreateBlock({ input, file }) : new ExpressiveCodeBlock(input)

			// Render the code block to HTML
			const blockHtml = await renderBlockToHtml({ codeBlock, renderer, addedStyles, addedJsModules })

			// Replace current node with a new HTML node that contains the rendered block
			const html: HTML = {
				type: 'html',
				value: blockHtml,
			}
			parent.children.splice(parent.children.indexOf(code), 1, html)
		}
	}

	return transformer
}

// eslint-disable-next-line deprecation/deprecation
export default remarkExpressiveCode
