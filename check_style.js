const fs = require('fs');
const js = fs.readFileSync('dist/extension.js', 'utf8');
const match = js.match(/const STYLE = `([^`]+)`/);
if (match) {
    console.log("STYLE MATCH FOUND:");
    console.log(match[1].substring(0, 500) + '...');
} else {
    console.log("NO STYLE MATCH");
}

const lines = js.split('\n');
const cshl = lines.filter(l => l.includes('.cs-hl-resolved'));
console.log("\nCS-HL-RESOLVED LINES:");
console.log(cshl.join('\n'));
