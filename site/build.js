'use strict'

const fs = require('fs')
const path = require('path')
const { marked } = require('marked')

const SITE_DIR = __dirname
const CONTENT_DIR = path.join(SITE_DIR, 'content')
const TEMPLATE_PATH = path.join(SITE_DIR, 'template.html')
const OUTPUT_PATH = path.join(SITE_DIR, 'index.html')
const CONFIG_DETAILS_PATH = path.join(SITE_DIR, 'config-details.html')

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

const configDetailsOutput = template
  .replace(/<section id="config" class="config">[\s\S]*?<\/section>/, `<section id="config" class="config">\n${marked.parse(readMd('config-details.md'))}    </section>`)
  .replace(/\s*<section class="hero">[\s\S]*?<\/section>/, '')
  .replace(/\s*<section class="demo">[\s\S]*?<\/section>/, '')
  .replace(/\s*<section id="get-going" class="get-going">[\s\S]*?<\/section>/, '')
  .replace(/\s*<section id="features" class="features">[\s\S]*?<\/section>/, '')
  .replace(/\s*<section id="agents" class="agents">[\s\S]*?<\/section>/, '')

fs.writeFileSync(CONFIG_DETAILS_PATH, configDetailsOutput)

console.log(`[site] built ${OUTPUT_PATH}`)
console.log(`[site] built ${CONFIG_DETAILS_PATH}`)
