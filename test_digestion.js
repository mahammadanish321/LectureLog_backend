import { startDigestion } from './src/services/digestion.service.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  console.log("Starting digestion test...");
  // Use the ID of the failed document
  const padDocId = '898e48d2-8f2d-4ce3-9613-2efc20098cd0';
  const fileUrl = 'https://res.cloudinary.com/dmi7vzu8w/raw/upload/v1785057968/lecturelog_bag/uymsnrrd5kwj2mf0hten';
  const fileName = 'Grammar.pdf';
  
  await startDigestion(padDocId, fileUrl, fileName);
  console.log("Done");
}
run();
