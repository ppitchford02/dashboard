// Compile only our own tool schemas. Runtime needs no npm installation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Ajv = require('ajv');
const standalone = require('ajv/dist/standalone');
const {tools} = require('../picks-mcp.js');
const ajv = new Ajv({code:{source:true}, strict:true, allErrors:false});
const ids = {};
for (const tool of tools) {ajv.addSchema(tool.inputSchema,tool.name);ids[tool.name]=tool.name;}
const hash = crypto.createHash('sha256').update(JSON.stringify(tools.map(t=>[t.name,t.inputSchema]))).digest('hex');
const output = '// Generated with Ajv 8.17.1 (MIT); regenerate with npm run build:validators.\n'+standalone(ajv,ids)+'\nexports.schemaHash='+JSON.stringify(hash)+';\n';
if (/require\(/.test(output)) throw Error('Generated validators must stay standalone for CI and Claude.');
fs.writeFileSync(path.join(__dirname,'../picks-validators.js'), output);
