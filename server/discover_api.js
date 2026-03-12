const pdfLib = require('pdf-parse');
console.log("Exports:", Object.keys(pdfLib));
if (pdfLib.PDFParse) {
    console.log("PDFParse type:", typeof pdfLib.PDFParse);
    console.log("PDFParse prototype methods:", Object.getOwnPropertyNames(pdfLib.PDFParse.prototype));
}
