#!/usr/bin/env node
/* eslint-disable no-console */
import minimist from 'minimist'
import StoryblokClient from 'storyblok-js-client'
import { performance } from 'perf_hooks'
import dotenvx from '@dotenvx/dotenvx'
import cloneDeep from 'clone-deep'
import * as deepl from 'deepl-node'

const startTime = performance.now()

dotenvx.config({ quiet: true })

const args = minimist(process.argv.slice(2))

if ('help' in args) {
	console.log(`USAGE
  $ npx storyblok-translate-asset-meta
  
OPTIONS
  --token <token>                (required) Personal OAuth access token created
                                 in the account settings of a Stoyblok user.
                                 (NOT the Access Token of a Space!)
                                 Alternatively, you can set the STORYBLOK_OAUTH_TOKEN environment variable.
  --space <space_id>             (required) ID of the space to backup
                                 Alternatively, you can set the STORYBLOK_SPACE_ID environment variable.
  --deepl-api-key <key>          (required) DeepL API Key
                                 Alternatively, you can set the DEEPL_API_KEY environment variable.
  --region <region>              Region of the space. Possible values are:
                                 - 'eu' (default): EU
                                 - 'us': US
                                 - 'ap': Australia
                                 - 'ca': Canada
                                 - 'cn': China
                                 Alternatively, you can set the STORYBLOK_REGION environment variable.
  --fields <fields>              Comma seperated list of meta-data fields to translate.
                                 Defaults to all ("alt,title,copyright,source").
                                 (e.g. --fields "alt,title")
  --source-lang <source-lang>    Source locale to translate from (=default Storyblok locale).
                                 Defaults uses DeepL auto-detection.
  --content-types <types>        Comma seperated list of content/component types to process. Defaults to all.
                                 (e.g. --content-types "page,news-article")
  --skip-stories <stories>       Comma seperated list of the full-slugs of stories to skip.
                                 (e.g. --skip-stories "home,about-us")
  --only-stories <stories>       Comma seperated list of the full-slugs of stories you want to limit processing to.
                                 (e.g. --only-stories "about-us")
  --locales <locales>            Comma seperated languages to process. Leave empty for all languages.
                                 (e.g. --locales "de,fr")
  --overwrite                    Overwrites existing translations. Defaults to false.
  --publish                      Publish stories after updating. Defaults to false.
                                 WARNING: May publish previously unpublished stories.
  --dry-run                      Only display the changes instead of performing them. Defaults to false.
  --verbose                      Show detailed output for every processed asset.
  --help                         Show this help

MINIMAL EXAMPLE
  $ npx storyblok-translate-asset-meta --token 1234567890abcdef --space 12345 --deepl-api-key 1234567890abcdef

MAXIMAL EXAMPLE
  $ npx storyblok-translate-asset-meta \\
      --token 1234567890abcdef \\
      --deepl-api-key 1234567890abcdef \\
      --region us \\
      --fields "alt,title" \\
      --source-lang en \\
      --content-types "page,news-article" \\
      --skip-stories "home" \\
      --locales "de,fr" \\
      --overwrite \\
      --publish \\
      --dry-run
      --verbose
`)
	process.exit(0)
}

if (!('token' in args) && !process.env.STORYBLOK_OAUTH_TOKEN) {
	console.log(
		'Error: State your oauth token via the --token argument or the environment variable STORYBLOK_OAUTH_TOKEN. Use --help to find out more.'
	)
	process.exit(1)
}
const oauthToken = args.token || process.env.STORYBLOK_OAUTH_TOKEN

if (!('space' in args) && !process.env.STORYBLOK_SPACE_ID) {
	console.log(
		'Error: State your space id via the --space argument or the environment variable STORYBLOK_SPACE_ID. Use --help to find out more.'
	)
	process.exit(1)
}
const spaceId = args.space || process.env.STORYBLOK_SPACE_ID

let region = 'eu'
if ('region' in args || process.env.STORYBLOK_REGION) {
	region = args.region || process.env.STORYBLOK_REGION

	if (!['eu', 'us', 'ap', 'ca', 'cn'].includes(region)) {
		console.log('Error: Invalid region parameter stated. Use --help to find out more.')
		process.exit(1)
	}
}

const verbose = 'verbose' in args

if (!('deepl-api-key' in args) && !process.env.DEEPL_API_KEY) {
	console.log(
		'Error: State your DeepL API key via the --deepl-api-key argument or the environment variable DEEPL_API_KEY. Use --help to find out more.'
	)
	process.exit(1)
}
const deeplApiKey = args['deepl-api-key'] || process.env.DEEPL_API_KEY

const sourceLang = args['source-lang'] || null

const contentTypes = args['content-types'] ? args['content-types'].split(',') : null

const locales = args['locales'] ? args['locales'].split(',') : []

const skipStories = args['skip-stories'] ? args['skip-stories'].split(',') : []

const onlyStories = args['only-stories'] ? args['only-stories'].split(',') : []

const fields = args['fields'] ? args['fields'].split(',') : ['alt', 'title', 'copyright', 'source']

// Init Management API
const StoryblokMAPI = new StoryblokClient({
	oauthToken: oauthToken,
	region: region,
})

// Init DeepL API
const translator = new deepl.Translator(deeplApiKey)

// Fetch space info
if (locales.length === 0) {
	console.log(`No locales stated.`)
	console.log(`Fetching space locales...`)
	const spaceInfo = await StoryblokMAPI.get(`spaces/${spaceId}/`)
	spaceInfo.data.space.languages.map((language) => locales.push(language.code))
}

// Setup translation cache
const translationCache = {}
locales.map((locale) => (translationCache[locale] = {}))

// Default translate function
let detectedSourceLang = null
let totalBilledCharacters = 0
const translate = async (text, targetLang) => {
	if (text in translationCache[targetLang]) {
		return translationCache[targetLang][text]
	}

	const translationResult = await translator.translateText(text, sourceLang, targetLang)

	translationCache[targetLang][text] = translationResult.text

	totalBilledCharacters += translationResult.billedCharacters

	// Check, if auto-detected source language is consistent.
	if (sourceLang === null) {
		if (!detectedSourceLang) {
			detectedSourceLang = translationResult.detectedSourceLang
		} else if (translationResult.detectedSourceLang !== detectedSourceLang) {
			console.log(
				`Error: Detected source language (${translationResult.detectedSourceLang}) is different from previously detected languages (${detectedSourceLang}). You might want to state a fixed source language using the --source-lang parameter.`
			)
			process.exit(1)
		}
	}

	return translationResult.text
}

// General information
console.log('')
console.log(`Performing translation of alt-text for space ${spaceId}:`)
console.log(`- mode: ${args['dry-run'] ? 'dry-run' : 'live'}`)
console.log(`- publish: ${args.publish ? 'yes' : 'no'}`)
console.log(`- overwrite: ${args.overwrite ? 'yes' : 'no'}`)
console.log(`- fields: ${fields.join(', ')}`)
console.log(`- source locale: ${sourceLang || 'auto-detect'}`)
console.log(`- target locales: ${locales.join(', ')}`)
console.log(`- content types: ${contentTypes ? contentTypes.join(', ') : 'all'}`)
if (skipStories.length > 0) {
	console.log(`- skipped stories: ${skipStories.join(', ')}`)
}
if (onlyStories.length > 0) {
	console.log(`- only stories: ${onlyStories.join(', ')}`)
}

// Fetch all stories
console.log('')
console.log(`Fetching stories...`)
const stories = []
const storyList = await StoryblokMAPI.getAll(`spaces/${spaceId}/stories`)
for (const story of storyList) {
	if (
		!story.is_folder &&
		(!contentTypes || contentTypes.includes(story.content_type)) &&
		!skipStories.includes(story.full_slug) &&
		(onlyStories.length > 0 ? onlyStories.includes(story.full_slug) : true)
	) {
		const storyData = await StoryblokMAPI.get(`spaces/${spaceId}/stories/${story.id}`)
		stories.push(storyData.data.story)
	}
}

// Fetch all components
console.log('')
console.log(`Fetching components...`)
const components = await StoryblokMAPI.getAll(`spaces/${spaceId}/components`)

// Check if field is translatable
const isFieldTranslatable = (componentName, fieldName) => {
	const component = components.find((component) => component.name === componentName)
	if (!component) {
		console.log(`Error: Component "${componentName}" not found in component list.`)
		process.exit(1)
	}
	if (!(fieldName in component.schema)) {
		console.log(`Error: field "${fieldName}" not found in component "${componentName}".`)
		process.exit(1)
	}
	return component.schema[fieldName].translatable || false
}

// Used to check if story update is required
let storyUpdateRequired = false

// Check if item is an object
const isObject = (item) => typeof item === 'object' && !Array.isArray(item) && item !== null

// Check if item is an asset object
const isAssetObject = (item) =>
	isObject(item) && 'fieldtype' in item && item.fieldtype === 'asset' && item.filename

// Perform translation of an asset field
const translateAssetField = async (value, locale) => {
	const translatedValue = await translate(value, locale)
	verboseLog(`      Translation to "${locale}": ${translatedValue}`)
	return translatedValue
}

// Write console.log, if verbose mode is enabled
const verboseLog = (...args) => {
	if (verbose) {
		console.log(...args)
	}
}

// Parse content node of a story.
const parseContentNode = async (node) => {
	if (isObject(node)) {
		for (const [key, subNode] of Object.entries(node)) {
			// Skip subnode, if it is already a translation.
			if (key.includes('__i18n__')) {
				continue
			}

			// If subnode is a single asset field...
			if (isAssetObject(subNode)) {
				verboseLog(`- Single asset field "${key}":`)

				if (!isFieldTranslatable(node.component, key)) {
					verboseLog(`  Field is not marked as translatable. Skipping.`)
					continue
				}

				// Establish languages to translate
				const locales2Process = []
				for (const locale of locales) {
					if (`${key}__i18n__${locale}` in node && !args.overwrite) {
						verboseLog(
							`  Translation already exists for language "${locale}". Use parameter --overwrite to force translation.`
						)
					} else {
						locales2Process.push(locale)
						node[`${key}__i18n__${locale}`] = cloneDeep(subNode)
					}
				}
				if (locales2Process.length > 0) {
					verboseLog(`  - Asset ${subNode.filename}:`)
					for (const field of fields) {
						verboseLog(`    - Field "${field}":`)
						if (!subNode.meta_data[field]) {
							verboseLog(`      Not set in default language. Skipping.`)
							continue
						}
						verboseLog(`      Default value: ${subNode.meta_data[field]}`)
						for (const locale of locales2Process) {
							const translatedValue = await translateAssetField(
								subNode.meta_data[field],
								locale
							)
							node[`${key}__i18n__${locale}`][field] = translatedValue
							node[`${key}__i18n__${locale}`].meta_data[field] = translatedValue
							storyUpdateRequired = true
						}
					}
				}
			}
			// If subnode is a multi-asset field...
			else if (Array.isArray(subNode) && subNode.length > 0 && isAssetObject(subNode[0])) {
				verboseLog(`- Multi asset field "${key}":`)

				if (!isFieldTranslatable(node.component, key)) {
					verboseLog(`  Field is not marked as translatable. Skipping.`)
					continue
				}

				// Establish languages to translate
				const locales2Process = []
				for (const locale of locales) {
					if (`${key}__i18n__${locale}` in node && !args.overwrite) {
						verboseLog(
							`  Translation already exists for language "${locale}". Use parameter --overwrite to force translation.`
						)
					} else {
						locales2Process.push(locale)
						node[`${key}__i18n__${locale}`] = cloneDeep(subNode)
					}
				}
				if (locales2Process.length > 0) {
					for (const i in subNode) {
						const item = subNode[i]
						verboseLog(`  - Asset ${item.filename}:`)
						for (const field of fields) {
							verboseLog(`    - Field "${field}":`)
							if (!item.meta_data[field]) {
								verboseLog(`      Not set in default language. Skipping.`)
								continue
							}
							verboseLog(`      Default value: ${item.meta_data[field]}`)
							for (const locale of locales2Process) {
								const translatedValue = await translateAssetField(
									item.meta_data[field],
									locale
								)
								node[`${key}__i18n__${locale}`][i][field] = translatedValue
								node[`${key}__i18n__${locale}`][i].meta_data[field] =
									translatedValue
								storyUpdateRequired = true
							}
						}
					}
				}
			}
			// If subnode is any other array...
			else if (Array.isArray(subNode)) {
				node[key] = await Promise.all(
					subNode.map(async (item) => await parseContentNode(item))
				)
			}
			// If subnode is any other object...
			else {
				node[key] = await parseContentNode(subNode)
			}
		}
	}

	return node
}

// Process stories
console.log('')
console.log(`Processing stories...`)
for (const story of stories) {
	storyUpdateRequired = false

	verboseLog('')
	verboseLog(`Slug "${story.full_slug}" / Name "${story.name}"`)

	story.content = await parseContentNode(story.content)

	if (!storyUpdateRequired) {
		verboseLog('No update required.')
		continue
	}

	if (args['dry-run']) {
		verboseLog('Dry-run mode. No changes performed.')
		continue
	}

	await StoryblokMAPI.put(`spaces/${spaceId}/stories/${story.id}`, {
		story: story,
		...(args.publish ? { publish: 1 } : {}),
	})

	verboseLog('Story successfully updated.')
}

const endTime = performance.now()

console.log('')
console.log(`Process successfully finished in ${Math.round((endTime - startTime) / 1000)} seconds.`)
console.log(`Total DeepL billed characters: ${totalBilledCharacters}`)
process.exit(0)
