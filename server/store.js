// Storage. Uses only the MONGODB_DB database (default "pip") on the shared cluster and never
// drops or clears anything. Without MONGODB_URI it falls back to an in-memory store with the
// same interface so the API still runs locally.
import { MongoClient, ObjectId } from 'mongodb';

const byNDesc = (a, b) => b.n - a.n;

class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.lessons = new Map();
    this.queue = [];
    this.timeline = new Map();
    this.meta = new Map();
    this.seq = 0;
  }
  async init() {}
  async close() {}

  async insertLesson(doc) {
    if (this.lessons.has(doc.n)) return false;
    this.lessons.set(doc.n, { ...doc });
    return true;
  }
  async listLessons({ limit = 30, before = null } = {}) {
    let all = [...this.lessons.values()].sort(byNDesc);
    if (before != null) all = all.filter((l) => l.n < before);
    return all.slice(0, limit).map((l) => ({ ...l }));
  }
  async countLessons() { return this.lessons.size; }

  async isBurnUsed(txHash) {
    return this.queue.some((q) => q.burnTx === txHash.toLowerCase());
  }
  async enqueue(item) {
    const burnTx = item.burnTx.toLowerCase();
    if (this.queue.some((q) => q.burnTx === burnTx)) return { duplicate: true };
    const doc = { ...item, burnTx, _id: String(++this.seq), status: 'pending', chunkIndex: 0, failures: 0 };
    this.queue.push(doc);
    return { position: await this.positionOf(doc._id) };
  }
  pending() { return this.queue.filter((q) => q.status === 'pending').sort((a, b) => a.at - b.at || Number(a._id) - Number(b._id)); }
  async positionOf(id) {
    const i = this.pending().findIndex((q) => q._id === id);
    return i < 0 ? null : i + 1;
  }
  async nextQueued() { const q = this.pending()[0]; return q ? { ...q } : null; }
  async listQueue(limit = 100) { return this.pending().slice(0, limit).map((q) => ({ ...q })); }
  async queueLength() { return this.pending().length; }
  async updateQueue(id, set) {
    const q = this.queue.find((x) => x._id === id);
    if (q) Object.assign(q, set);
  }

  async addSnapshot(doc) {
    if (this.timeline.has(doc.lesson)) return false;
    this.timeline.set(doc.lesson, { ...doc });
    return true;
  }
  async hasSnapshot(lesson) { return this.timeline.has(lesson); }
  async listTimeline() { return [...this.timeline.values()].sort((a, b) => a.lesson - b.lesson); }

  async getMeta(key, def = null) { return this.meta.has(key) ? this.meta.get(key) : def; }
  async setMeta(key, value) { this.meta.set(key, value); }
}

class MongoStore {
  constructor(uri, dbName) {
    this.kind = 'mongo';
    this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
    this.dbName = dbName;
  }
  async init() {
    await this.client.connect();
    const db = this.client.db(this.dbName);
    this.lessons = db.collection('lessons');
    this.queue = db.collection('queue');
    this.timeline = db.collection('timeline');
    this.meta = db.collection('meta');
    await Promise.all([
      this.lessons.createIndex({ n: 1 }, { unique: true }),
      this.queue.createIndex({ burnTx: 1 }, { unique: true }),
      this.queue.createIndex({ status: 1, at: 1 }),
      this.timeline.createIndex({ lesson: 1 }, { unique: true }),
      this.meta.createIndex({ key: 1 }, { unique: true }),
    ]);
  }
  async close() { await this.client.close().catch(() => {}); }

  async insertLesson(doc) {
    const r = await this.lessons.updateOne({ n: doc.n }, { $setOnInsert: doc }, { upsert: true });
    return r.upsertedCount === 1;
  }
  async listLessons({ limit = 30, before = null } = {}) {
    const q = before != null ? { n: { $lt: before } } : {};
    return this.lessons.find(q, { projection: { _id: 0 } }).sort({ n: -1 }).limit(limit).toArray();
  }
  async countLessons() { return this.lessons.estimatedDocumentCount(); }

  async isBurnUsed(txHash) {
    return (await this.queue.countDocuments({ burnTx: txHash.toLowerCase() }, { limit: 1 })) > 0;
  }
  async enqueue(item) {
    const doc = { ...item, burnTx: item.burnTx.toLowerCase(), status: 'pending', chunkIndex: 0, failures: 0 };
    try {
      const r = await this.queue.insertOne(doc);
      return { position: await this.positionOf(r.insertedId) };
    } catch (e) {
      if (e && e.code === 11000) return { duplicate: true };
      throw e;
    }
  }
  async positionOf(id) {
    const _id = typeof id === 'string' ? new ObjectId(id) : id;
    const me = await this.queue.findOne({ _id });
    if (!me || me.status !== 'pending') return null;
    const ahead = await this.queue.countDocuments({
      status: 'pending',
      $or: [{ at: { $lt: me.at } }, { at: me.at, _id: { $lt: me._id } }],
    });
    return ahead + 1;
  }
  async nextQueued() {
    const q = await this.queue.find({ status: 'pending' }).sort({ at: 1, _id: 1 }).limit(1).next();
    return q ? { ...q, _id: String(q._id) } : null;
  }
  async listQueue(limit = 100) {
    const rows = await this.queue.find({ status: 'pending' }).sort({ at: 1, _id: 1 }).limit(limit).toArray();
    return rows.map((q) => ({ ...q, _id: String(q._id) }));
  }
  async queueLength() { return this.queue.countDocuments({ status: 'pending' }); }
  async updateQueue(id, set) {
    await this.queue.updateOne({ _id: new ObjectId(id) }, { $set: set });
  }

  async addSnapshot(doc) {
    const r = await this.timeline.updateOne({ lesson: doc.lesson }, { $setOnInsert: doc }, { upsert: true });
    return r.upsertedCount === 1;
  }
  async hasSnapshot(lesson) { return (await this.timeline.countDocuments({ lesson }, { limit: 1 })) > 0; }
  async listTimeline() {
    return this.timeline.find({}, { projection: { _id: 0 } }).sort({ lesson: 1 }).toArray();
  }

  async getMeta(key, def = null) {
    const d = await this.meta.findOne({ key });
    return d ? d.value : def;
  }
  async setMeta(key, value) {
    await this.meta.updateOne({ key }, { $set: { key, value } }, { upsert: true });
  }
}

export async function createStore(config, log = console) {
  if (!config.mongoUri) {
    log.warn('[store] MONGODB_URI not set, using in-memory store (data is lost on restart)');
    const s = new MemoryStore();
    await s.init();
    return s;
  }
  const s = new MongoStore(config.mongoUri, config.mongoDb);
  await s.init();
  log.log(`[store] connected to Mongo, db "${config.mongoDb}"`);
  return s;
}

export { MemoryStore };
