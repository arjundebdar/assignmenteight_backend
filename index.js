import express from "express";
import cors from "cors";
import multer from "multer";
import { MongoClient, ObjectId } from "mongodb";
import { v2 as cloudinary } from "cloudinary";
import "dotenv/config";

const app = express();
const PORT = 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Multer Configuration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

// Cloudinary Configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// MongoDB Configuration

// MongoDB Configuration
let client;
let dbPromise;

let booksCollection;
let borrowedBooksCollection;

// Connect MongoDB
const connectToMongoDB = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is missing!");
  }

  if (!dbPromise) {
    client = new MongoClient(process.env.MONGODB_URI);

    dbPromise = client
      .connect()
      .then(() => {
        const db = client.db("libraryDB");

        booksCollection = db.collection("books");
        borrowedBooksCollection = db.collection("borrowedBooks");

        console.log("You successfully connected to MongoDB!");
      })
      .catch((error) => {
        dbPromise = null;
        throw error;
      });
  }

  return dbPromise;
};

// Connect before handling API requests
app.use(async (req, res, next) => {
  try {
    await connectToMongoDB();
    next();
  } catch (error) {
    console.error("MongoDB Connection Error:", error);

    res.status(500).send({
      message: "Database connection failed",
    });
  }
});

// Cloudinary Image Upload Function
const uploadImage = async (file) => {
  return new Promise((resolve, reject) => {
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
            resolve(result.secure_url);
          }
        },
      )
      .end(file.buffer);
  });
};

// GET ALL BOOKS
app.get("/books", async (req, res) => {
  try {
    const books = await booksCollection.find().toArray();

    res.send(books);
  } catch (error) {
    res.status(500).send({
      message: error.message,
    });
  }
});

// GET SINGLE BOOK
app.get("/books/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid book ID",
      });
    }

    const book = await booksCollection.findOne({
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

// ADD BOOK
app.post("/books", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send({
        message: "Please upload a book image!",
      });
    }

    // Upload image to Cloudinary
    const imageUrl = await uploadImage(req.file);

    // Book Data
    const bookData = {
      ...req.body,
      totalCopies: Number(req.body.totalCopies),
      image: imageUrl,
    };

    // Save to MongoDB
    const result = await booksCollection.insertOne(bookData);

    res.status(201).send({
      message: "Book added successfully!",
      insertedId: result.insertedId,
      image: imageUrl,
    });
  } catch (error) {
    console.error("Book Upload Error:", error);

    res.status(500).send({
      message: error.message || "Failed to add book",
    });
  }
});

// UPDATE BOOK
app.put("/books/:id", upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid book ID",
      });
    }

    // Find existing book
    const existingBook = await booksCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!existingBook) {
      return res.status(404).send({
        message: "Book not found",
      });
    }

    // Keep previous image
    let imageUrl = existingBook.image;

    // Upload new image only if selected
    if (req.file) {
      imageUrl = await uploadImage(req.file);
    }

    // Updated Data
    const updatedBook = {
      title: req.body.title,
      author: req.body.author,
      category: req.body.category,
      totalCopies: Number(req.body.totalCopies),
      description: req.body.description,
      image: imageUrl,
    };

    // Update MongoDB
    await booksCollection.updateOne(
      {
        _id: new ObjectId(id),
      },
      {
        $set: updatedBook,
      },
    );

    res.send({
      message: "Book updated successfully!",
      image: imageUrl,
    });
  } catch (error) {
    console.error("Book Update Error:", error);

    res.status(500).send({
      message: error.message || "Failed to update book",
    });
  }
});

// DELETE BOOK
app.delete("/books/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid book ID",
      });
    }

    const result = await booksCollection.deleteOne({
      _id: new ObjectId(id),
    });

    if (result.deletedCount === 0) {
      return res.status(404).send({
        message: "Book not found",
      });
    }

    res.send({
      message: "Book deleted successfully!",
    });
  } catch (error) {
    res.status(500).send({
      message: error.message,
    });
  }
});

// BORROW BOOK
app.post("/borrow", async (req, res) => {
  const { bookId, userName, userEmail } = req.body;

  if (!ObjectId.isValid(bookId)) {
    return res.status(400).send({
      message: "Invalid book ID",
    });
  }

  if (!userEmail) {
    return res.status(400).send({
      message: "User email is required",
    });
  }

  const mongoSession = client.startSession();

  try {
    let borrowedBook;

    await mongoSession.withTransaction(async () => {
      // Decrease available quantity atomically
      const bookUpdate = await booksCollection.updateOne(
        {
          _id: new ObjectId(bookId),
          totalCopies: { $gt: 0 },
        },
        {
          $inc: { totalCopies: -1 },
        },
        { session: mongoSession },
      );

      if (bookUpdate.modifiedCount === 0) {
        throw new Error("BOOK_NOT_AVAILABLE");
      }

      const book = await booksCollection.findOne(
        { _id: new ObjectId(bookId) },
        { session: mongoSession },
      );

      const borrowDate = new Date();
      const returnDate = new Date(borrowDate);
      returnDate.setDate(returnDate.getDate() + 14);

      borrowedBook = {
        bookId: new ObjectId(bookId),
        title: book.title,
        image: book.image,
        userName,
        userEmail,
        borrowDate,
        returnDate,
        status: "borrowed",
      };

      await borrowedBooksCollection.insertOne(borrowedBook, {
        session: mongoSession,
      });
    });

    res.status(201).send({
      message: "Book borrowed successfully!",
      borrowedBook,
    });
  } catch (error) {
    console.error("Borrow Book Error:", error);

    if (error.message === "BOOK_NOT_AVAILABLE") {
      return res.status(409).send({
        message: "Sorry! This book is currently unavailable.",
      });
    }

    res.status(500).send({
      message: error.message || "Failed to borrow book",
    });
  } finally {
    await mongoSession.endSession();
  }
});

// GET MY BORROWED BOOKS
app.get("/my-borrows/:email", async (req, res) => {
  try {
    const { email } = req.params;

    const borrowedBooks = await borrowedBooksCollection
      .find({
        userEmail: email,
        status: "borrowed",
      })
      .sort({ borrowDate: -1 })
      .toArray();

    res.send(borrowedBooks);
  } catch (error) {
    res.status(500).send({
      message: error.message,
    });
  }
});

// RETURN BORROWED BOOK
app.patch("/borrow/:id/return", async (req, res) => {
  const { id } = req.params;

  if (!ObjectId.isValid(id)) {
    return res.status(400).send({
      message: "Invalid borrow ID",
    });
  }

  const mongoSession = client.startSession();

  try {
    await mongoSession.withTransaction(async () => {
      // Change status only if it is still borrowed
      const borrowUpdate = await borrowedBooksCollection.updateOne(
        {
          _id: new ObjectId(id),
          status: "borrowed",
        },
        {
          $set: {
            status: "returned",
            returnedAt: new Date(),
          },
        },
        { session: mongoSession },
      );

      if (borrowUpdate.modifiedCount === 0) {
        throw new Error("ALREADY_RETURNED");
      }

      // Increase available quantity
      const bookUpdate = await booksCollection.updateOne(
        {
          _id: (
            await borrowedBooksCollection.findOne(
              { _id: new ObjectId(id) },
              { session: mongoSession },
            )
          ).bookId,
        },
        {
          $inc: { totalCopies: 1 },
        },
        { session: mongoSession },
      );

      if (bookUpdate.matchedCount === 0) {
        throw new Error("BOOK_NOT_FOUND");
      }
    });

    res.send({
      message: "Book returned successfully!",
    });
  } catch (error) {
    console.error("Return Book Error:", error);

    if (error.message === "ALREADY_RETURNED") {
      return res.status(409).send({
        message: "This book has already been returned.",
      });
    }

    if (error.message === "BOOK_NOT_FOUND") {
      return res.status(404).send({
        message: "Book not found.",
      });
    }

    res.status(500).send({
      message: error.message || "Failed to return book",
    });
  } finally {
    await mongoSession.endSession();
  }
});

// Start Server After MongoDB Connection
const startServer = async () => {
  await connectToMongoDB();

  if (process.env.NODE_ENV !== "production") {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  }
};

startServer();

export default app;
