'use strict';
// Vercel serverless entry point. vercel.json sends every /api/* request (and /extension.zip) here.
const server = require('../server.js');
module.exports = (req, res) => server.handler(req, res);
