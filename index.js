import express from "express";
import cors from "cors";
import multer from "multer";
import { MongoClient, ObjectId } from "mongodb";
import { v2 as cloudinary } from "cloudinary";
import "dotenv/config";

const app = express();
const PORT = 5000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json());

// Cloudinary Configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// MongoDB Connection
const client = new MongoClient(
  `mongodb://${process.env.DB_USER}:${process.env.DB_PASS}@ac-fnhayin-shard-00-00.1gmbeud.mongodb.net:27017,ac-fnhayin-shard-00-01.1gmbeud.mongodb.net:27017,ac-fnhayin-shard-00-02.1gmbeud.mongodb.net:27017/?ssl=true&replicaSet=atlas-ki9uz8-shard-0&authSource=admin`,
);

let booksCollection;

export async function connectToMongoDB() {
  try {
    await client.connect();

    console.log("You successfully connected to MongoDB!");

    const db = client.db("libraryDB");
    booksCollection = db.collection("books");

    return client;
  } catch (err) {
    console.error("MongoDB Connection Error:", err);
    throw err;
  }
}

// GET API
app.get("/booksList", async (req, res) => {
  try {
    const booklist = await booksCollection.find().toArray();
    res.json(booklist);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// POST API
app.post("/booksList", upload.single("image"), async (req, res) => {
  try {
    // Check image
    if (!req.file) {
      return res.status(400).send({
        message: "Please upload a book image!",
      });
    }

    // Upload image to Cloudinary
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader
        .upload_stream(
          {
            folder: "library-books",
            resource_type: "image",
          },
          (error, result) => {
            if (error) {
              reject(error);
            } else {
              resolve(result);
            }
          },
        )
        .end(req.file.buffer);
    });

    // Get image URL
    const imageUrl = result.secure_url;

    // Book Data
    const bookData = {
      ...req.body,
      totalCopies: Number(req.body.totalCopies),
      image: imageUrl,
    };

    // Save book to MongoDB
    const insertResult = await booksCollection.insertOne(bookData);

    res.status(201).send({
      message: "Book added successfully!",
      insertedId: insertResult.insertedId,
      image: imageUrl,
    });
  } catch (error) {
    console.error("Book Upload Error:", error);

    res.status(500).send({
      message: error.message || "Failed to add book",
    });
  }
});

// Connect MongoDB
const getBooks = await connectToMongoDB();

const db = getBooks.db("libraryDB");
const books = db.collection("books");

// GET All Books
app.get("/books", async (req, res) => {
  try {
    const cursor = books.find({});
    const allBooks = await cursor.toArray();

    res.send(allBooks);
  } catch (error) {
    res.status(500).send({
      message: error.message,
    });
  }
});

app.get("/books/:id", async (req, res) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid book ID",
      });
    }

    const book = await books.findOne({
      _id: new ObjectId(id),
    });

    if (!book) {
      return res.status(404).send({
        message: "Book not found",
      });
    }

    res.send(book);
  } catch (error) {
    res.status(500).send({
      message: error.message,
    });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
