// src/server.js
import app from './app.js';

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`NEC GATE Portal API running on http://localhost:${PORT}`);
  console.log(`Frontend Panel: http://localhost:3000`);
});