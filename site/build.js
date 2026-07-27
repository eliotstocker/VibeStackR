'use strict'

const fs = require('fs')
const path = require('path')
const { marked } = require('marked')

const SITE_DIR = __dirname
const CONTENT_DIR = path.join(SITE_DIR, 'content')
const TEMPLATE_PATH = path.join(SITE_DIR, 'template.html')
const OUTPUT_PATH = path.join(SITE_DIR, 'index.html')

const readMd = (name) => fs.readFileSync(path.join(CONTENT_DIR, name), 'utf8')

// features.md is several "### Title\n\nBody" blocks separated by a lone
// "---" line — each becomes its own card in the grid.
function renderFeatures(md) {
  return md
    .trim()
    .split(/\n---\n/)
    .map((block) => `    <div class="feature">\n${marked.parse(block.trim())}    </div>`)
    .join('\n')
}

const template = fs.readFileSync(TEMPLATE_PATH, 'utf8')

const output = template
  .replace('{{HERO}}', marked.parse(readMd('hero.md')))
  .replace('{{DEMO_CAPTION}}', marked.parse(readMd('demo-caption.md')))
  .replace('{{GET_GOING}}', marked.parse(readMd('get-going.md')))
  .replace('{{FEATURES}}', renderFeatures(readMd('features.md')))
  .replace('{{AGENTS}}', marked.parse(readMd('agents.md')))
  .replace('{{CONFIG}}', marked.parse(readMd('config.md')))

fs.writeFileSync(OUTPUT_PATH, output)
console.log(`[site] built ${OUTPUT_PATH}`)
