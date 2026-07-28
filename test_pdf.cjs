const { PDFParse } = require('pdf-parse');
async function test() {
  const url = 'https://res.cloudinary.com/dmi7vzu8w/raw/upload/v1785057968/lecturelog_bag/uymsnrrd5kwj2mf0hten';
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  
  try {
    const parser = new PDFParse({ data: buffer });
    const pdfData = await parser.getText();
    console.log("Parsed length:", pdfData.text.length);
    console.log("First 100 chars:", pdfData.text.substring(0, 100));
  } catch (e) {
    console.error("PDF parse failed:", e);
  }
}
test();
