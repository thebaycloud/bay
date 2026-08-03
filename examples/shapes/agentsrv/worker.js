// A queue consumer: no HTTP, must keep running between events.
setInterval(() => console.log("worker tick", new Date().toISOString()), 15000);
console.log("worker started");
