class foo {
  constructor(id) {
    this.id = id;
    const goodbye = `finalize: id: ` + id;
    this.finalize = () => console.log(goodbye);
  }
}

function garbageCollect() {
  try {
    console.log("garbageCollect: Collecting garbage...");
    global.gc();
  } catch (e) {
    console.log(
      `You must expose the gc() method => call using 'node --expose-gc app.js'`
    );
  }
}

let foos = Array.from({ length: 10 }, (v, k) => new foo(k + 1));

const registry = new FinalizationRegistry((heldValue) => heldValue());

foos.forEach((foo) => registry.register(foo, foo.finalize));

// Orphan our foos...
foos = null;

// Our foos should be garbage collected since no reference is being held to them
garbageCollect();
