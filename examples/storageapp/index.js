const http = require("http");
const { Storage } = require("@google-cloud/storage");

const bucketName = process.env.STORAGE_BUCKET;
const storage = new Storage();
const port = process.env.PORT || 8080;

http.createServer(async (req, res) => {
  try {
    const bucket = storage.bucket(bucketName);
    const fname = `hello-${Date.now()}.txt`;
    await bucket.file(fname).save("written by storageapp at " + new Date().toISOString());
    const [files] = await bucket.getFiles();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<h1>⚡ storageapp — wrote ${fname}</h1><p>bucket <b>${bucketName}</b> now has ${files.length} file(s)</p>`);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("storage error: " + e.message);
  }
}).listen(port, () => console.log("listening on " + port));
