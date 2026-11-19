import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import cors from "cors";
import "dotenv/config";
import { createRemoteJWKSet, jwtVerify } from "jose";

const app = express();
const PORT = process.env.PORT || 8000;

/* ---------- MongoDB ---------- */
const client = new MongoClient(process.env.MONGODB_URI);

let booksCollection;
let borrowCollection;

async function connectToMongoDB() {
  try {
    await client.connect();
    const db = client.db("yourlibrary");
    booksCollection = db.collection("books");
    borrowCollection = db.collection("borrows");
    console.log("You successfully connected to MongoDB!");
  } catch (err) {
    console.dir(err);
  }
}

await connectToMongoDB();

/* ---------- Middleware ---------- */
app.use(cors());
app.use(express.json());

const JWKS = createRemoteJWKSet(
  new URL(`${process.env.CLIENT_URL}/api/auth/jwks`),
);

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({ msg: "Unauthorized!" });
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).send({ msg: "Unauthorized!" });
  }

  try {
    const { payload } = await jwtVerify(token, JWKS);
    req.user = payload; // pore dorkar hole use kora jabe
    next();
  } catch (error) {
    return res.status(401).send({ msg: "Invalid or expired token!" });
  }
};

const isValidId = (id) => ObjectId.isValid(id);

/* ---------- Books ---------- */

// Notun book add
app.post("/add-book", verifyToken, async (req, res) => {
  try {
    const data = req.body;
    if (!data.title || !data.author) {
      return res.status(400).send({ msg: "Title and author are required" });
    }
    const book = {
      ...data,
      quantity: Number(data.quantity) || 1,
      createdAt: new Date(),
    };
    const result = await booksCollection.insertOne(book);
    res.send(result);
  } catch (error) {
    res.status(500).send({ msg: "Server Error!" });
  }
});

// Shob book
app.get("/books", async (req, res) => {
  try {
    const result = await booksCollection
      .find()
      .sort({ createdAt: -1 })
      .toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ msg: "Server Error!" });
  }
});

// Featured book (home page er jonno)
app.get("/featured-books", async (req, res) => {
  try {
    const result = await booksCollection
      .find()
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ msg: "Server Error!" });
  }
});

// Ekta book er details
app.get("/book/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).send({ msg: "Invalid book id" });
    }
    const result = await booksCollection.findOne({ _id: new ObjectId(id) });
    if (!result) {
      return res.status(404).send({ msg: "Book not found" });
    }
    res.send(result);
  } catch (error) {
    res.status(500).send({ msg: "Server Error!" });
  }
});

// Book update
app.patch("/book/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).send({ msg: "Invalid book id" });
    }
    const data = { ...req.body };
    delete data._id; // _id kokhono update kora jay na
    const result = await booksCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: data },
    );
    res.send(result);
  } catch (error) {
    res.status(500).send({ msg: "Server Error!" });
  }
});

// Book delete
app.delete("/book/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).send({ msg: "Invalid book id" });
    }
    const result = await booksCollection.deleteOne({ _id: new ObjectId(id) });
    res.send(result);
  } catch (error) {
    res.status(500).send({ msg: "Server Error!" });
  }
});

/* ---------- Borrow (dar nite) ---------- */

// Book dar nao
app.post("/borrow", verifyToken, async (req, res) => {
  try {
    const { bookId, email, returnDate } = req.body;

    if (!bookId || !email) {
      return res.status(400).send({ msg: "bookId and email are required" });
    }
    if (!isValidId(bookId)) {
      return res.status(400).send({ msg: "Invalid book id" });
    }

    const book = await booksCollection.findOne({ _id: new ObjectId(bookId) });
    if (!book) {
      return res.status(404).send({ msg: "Book not found" });
    }
    if ((book.quantity ?? 0) < 1) {
      return res.status(400).send({ msg: "Book is not available now" });
    }

    // Ek user ek-i book duibar dar nite parbe na
    const alreadyBorrowed = await borrowCollection.findOne({
      bookId,
      email,
    });
    if (alreadyBorrowed) {
      return res.status(400).send({ msg: "You already borrowed this book" });
    }

    const result = await borrowCollection.insertOne({
      bookId,
      email,
      title: book.title,
      author: book.author,
      image: book.image || "",
      returnDate: returnDate || null,
      borrowedAt: new Date(),
    });

    // Quantity 1 kome jabe
    await booksCollection.updateOne(
      { _id: new ObjectId(bookId) },
      { $inc: { quantity: -1 } },
    );

    res.send(result);
  } catch (error) {
    res.status(500).send({ msg: "Server Error!" });
  }
});

// Amar borrow kora book gulo
app.get("/my-borrows/:email", verifyToken, async (req, res) => {
  try {
    const { email } = req.params;
    const result = await borrowCollection
      .find({ email })
      .sort({ borrowedAt: -1 })
      .toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ msg: "Server Error!" });
  }
});

// Book ferot dao (borrow delete + quantity abar barano)
app.delete("/my-borrows/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).send({ msg: "Invalid borrow id" });
    }

    const borrow = await borrowCollection.findOne({ _id: new ObjectId(id) });
    if (!borrow) {
      return res.status(404).send({ msg: "Borrow record not found" });
    }

    const result = await borrowCollection.deleteOne({ _id: new ObjectId(id) });

    if (isValidId(borrow.bookId)) {
      await booksCollection.updateOne(
        { _id: new ObjectId(borrow.bookId) },
        { $inc: { quantity: 1 } },
      );
    }

    res.send(result);
  } catch (error) {
    res.status(500).send({ msg: "Server Error!" });
  }
});

/* ---------- Health check ---------- */
app.get("/", (req, res) => {
  res.send({ message: "Server is running fine!" });
});

app.listen(PORT, () => {
  console.log(`Server is running at ${PORT}`);
});

export default app;