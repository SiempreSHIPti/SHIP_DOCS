// src/google/clients.js
const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");

async function getClients() {
  const auth = new GoogleAuth({
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/presentations",
    ],
  });

  const authClient = await auth.getClient();

  return {
    authClient,
    sheets: google.sheets({ version: "v4", auth: authClient }),
    drive: google.drive({ version: "v3", auth: authClient }),
    slides: google.slides({ version: "v1", auth: authClient }),
  };
}

module.exports = { getClients };
