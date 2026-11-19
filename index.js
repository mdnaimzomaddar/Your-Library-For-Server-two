import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import cors from "cors";
import "dotenv/config";
import { createRemoteJWKSet, jwtVerify } from "jose";

const app = express();
const PORT = process.env.PORT || 8000;

/* ---------- MongoDB ---------- */
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db("yourlibrary");
const books = db.collection("books");
const borrows = db.collection("borrows");

/* ---------- Middleware ---------- */
app.use(cors());
app.use(express.json());

const JWKS = createRemoteJWKSet(
  new URL(`${process.env.CLIENT_URL}/api/auth/jwks`),
);

const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).send({ message: "লগইন করা নেই" });
  try {
    const { payload } = await jwtVerify(token, JWKS);
    req.user = payload;
    next();
  } catch (error) {
    console.error("JWT error:", error.message);
    res.status(401).send({ message: "আবার লগইন করো" });
  }
};

// all error's handeling
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).send({ message: "সার্ভারে সমস্যা হয়েছে" });
  });

const oid = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);

/* ---------- Books ---------- */
app.get("/books", wrap(async (req, res) => {
  const { category } = req.query;
  const filter = category && category !== "All" ? { category } : {};
  res.send(await books.find(filter).sort({ createdAt: -1 }).toArray());
}));

app.get("/featured-books", wrap(async (req, res) => {
  res.send(await books.find().sort({ createdAt: -1 }).limit(6).toArray());
}));

app.get("/books/:id", wrap(async (req, res) => {
  const _id = oid(req.params.id);
  const book = _id && (await books.findOne({ _id }));
  if (!book) return res.status(404).send({ message: "বইটি পাওয়া যায়নি" });
  res.send(book);
}));

app.post("/books", verifyToken, wrap(async (req, res) => {
  const d = req.body;
  const totalCopies = Number(d.totalCopies) || 1;
  const result = await books.insertOne({
    title: d.title,
    author: d.author,
    category: d.category,
    image: d.image,
    description: d.description,
    totalCopies,
    availableCopies: totalCopies,
    userName: d.userName,
    userEmail: req.user.email,
    createdAt: new Date(),
  });
  res.send(result);
}));

app.patch("/books/:id", verifyToken, wrap(async (req, res) => {
  const _id = oid(req.params.id);
  const book = _id && (await books.findOne({ _id }));
  if (!book) return res.status(404).send({ message: "বইটি পাওয়া যায়নি" });
  if (book.userEmail !== req.user.email)
    return res.status(403).send({ message: "অনুমতি নেই" });

  const data = { ...req.body };
  delete data._id;
  delete data.userEmail;
  delete data.createdAt;

  if (data.totalCopies !== undefined) {
    const borrowed = book.totalCopies - book.availableCopies;
    data.totalCopies = Number(data.totalCopies);
    data.availableCopies = Math.max(data.totalCopies - borrowed, 0);
  }
  res.send(await books.updateOne({ _id }, { $set: data }));
}));

app.delete("/books/:id", verifyToken, wrap(async (req, res) => {
  const _id = oid(req.params.id);
  const book = _id && (await books.findOne({ _id }));
  if (!book) return res.status(404).send({ message: "বইটি পাওয়া যায়নি" });
  if (book.userEmail !== req.user.email)
    return res.status(403).send({ message: "অনুমতি নেই" });
  res.send(await books.deleteOne({ _id }));
}));

app.get("/my-books", verifyToken, wrap(async (req, res) => {
  res.send(
    await books.find({ userEmail: req.user.email }).sort({ createdAt: -1 }).toArray(),
  );
}));

/* ---------- Borrow ---------- */
app.post("/borrows", verifyToken, wrap(async (req, res) => {
  const { bookId, returnDate } = req.body;
  const _id = oid(bookId);
  const book = _id && (await books.findOne({ _id }));
  if (!book) return res.status(404).send({ message: "বইটি পাওয়া যায়নি" });
  if (book.availableCopies < 1)
    return res.status(400).send({ message: "এই বইয়ের কপি এখন নেই" });

  const email = req.user.email;
  const active = await borrows.findOne({ bookId, userEmail: email, returned: false });
  if (active)
    return res.status(400).send({ message: "তুমি এই বইটি আগেই ধার নিয়েছ" });

  const result = await borrows.insertOne({
    bookId,
    bookTitle: book.title,
    bookImage: book.image,
    userEmail: email,
    userName: req.user.name,
    borrowDate: new Date(),
    returnDate,
    returned: false,
    returnedAt: null,
  });
  await books.updateOne({ _id }, { $inc: { availableCopies: -1 } });
  res.send(result);
}));

// my borrowed books list
app.get("/borrows", verifyToken, wrap(async (req, res) => {
  res.send(
    await borrows.find({ userEmail: req.user.email }).sort({ borrowDate: -1 }).toArray(),
  );
}));

// return a borrowed book
app.delete("/borrows/:id", verifyToken, wrap(async (req, res) => {
  const _id = oid(req.params.id);
  const borrow = _id && (await borrows.findOne({ _id }));
  if (!borrow) return res.status(404).send({ message: "রেকর্ড পাওয়া যায়নি" });
  if (borrow.userEmail !== req.user.email)
    return res.status(403).send({ message: "অনুমতি নেই" });
  if (borrow.returned)
    return res.status(400).send({ message: "বইটি আগেই ফেরত দেওয়া হয়েছে" });

  const result = await borrows.updateOne(
    { _id },
    { $set: { returned: true, returnedAt: new Date() } },
  );
  const bookId = oid(borrow.bookId);
  if (bookId) await books.updateOne({ _id: bookId }, { $inc: { availableCopies: 1 } });
  res.send(result);
}));


app.get("/", (req, res) => res.send({ message: "Server is running fine!" }));

app.listen(PORT, () => console.log(`Server is running at ${PORT}`));

export default app;