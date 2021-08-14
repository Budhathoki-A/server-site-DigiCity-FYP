const express = require("express");
const app = express();
const admin = require("firebase-admin");
const cors = require("cors");
const serviceAccount = require("./learning-bunny-c772e-firebase-adminsdk-suj15-cdc1993fd9.json");
const { stripeKey } = require("./info");
const stripe = require("stripe")(stripeKey);

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const adminAuth = admin.auth();
const adminDatabase = admin.firestore();
const corsOptions = {
  origin: "*",
  credentials: true, //access-control-allow-credentials:true
  optionSuccessStatus: 200,
};
app.use(cors(corsOptions));
app.use(express.json());

app.post("/add-user", async (req, res) => {
  try {
    const { id, fullname, email, auth, password } = req.body;
    const parentExists = await adminDatabase.collection("users").doc(id).get();

    if (parentExists.exists) {
      if (parentExists.data().stripeSubId) {
        if (
          !parentExists.data().child ||
          parentExists.data().child.length === 0
        ) {
          //create child account
          const childRecord = await adminAuth.createUser({
            email,
            fullname,
            password,
            emailVerified: false,
            auth,
          });
          //add child uid to parents child array

          await adminDatabase
            .collection("users")
            .doc(id)
            .set({ child: [childRecord.uid] }, { merge: true });

          //add child account in users collection
          await adminDatabase.collection("users").doc(childRecord.uid).set({
            id: childRecord.uid,
            email,
            fullname,
            auth,
            avatar: null,
            awards: [],
            parent: id,
          });

          return res.json({
            message: "Successful",
            childId: childRecord.uid,
          });
        }
        return res.status(409).json({ message: "Account already exists" });
      }
      return res.status(401).json({ message: "Unauthorized" });
    }
    return res.status(401).json({ message: "Unauthorized" });
  } catch (error) {
    res.json(error);
  }
});

app.post("/create-checkout-session", async (req, res) => {
  let { priceId, domainUrl } = req.body;

  try {
    console.log(priceId, domainUrl);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      // ?session_id={CHECKOUT_SESSION_ID} means the redirect will have the session ID set as a query param
      success_url: `${domainUrl}?q=su,session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${domainUrl}?q=fa`,
    });

    console.log("A");
    return res.json({ redirectUrl: session.url });
  } catch (e) {
    res.status(400);
    return res.send({
      error: {
        message: e.message,
      },
    });
  }
});

app.post("/cancel-subcription", async (req, res) => {
  const { subId, userId } = req.body;
  console.log(subId);
  await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
  await adminDatabase.collection("users").doc(userId).update({
    subscriptionStatus: 1,
  });

  res.json({ message: "done" });
});

app.post("/new-subcription", async (req, res) => {
  const { sessionId, userId } = req.body;
  try {
    const response = await stripe.checkout.sessions.retrieve(sessionId);

    const customerId = response.customer;
    const subscriptionId = response.subscription;
    const subcriptionObj = await stripe.subscriptions.retrieve(subscriptionId);
    console.log("response", subcriptionObj);
    const usersWithSameSubId = await adminDatabase
      .collectionGroup("users")
      .where("stripeSubId", "==", subscriptionId)
      .get();
    if (usersWithSameSubId.docs.length === 0) {
      if (subcriptionObj.status === "active") {
        await adminDatabase.collection("users").doc(userId).set(
          {
            stripeCustomerId: customerId,
            stripeSubId: subscriptionId,
            expiresAt: subcriptionObj.current_period_end,
            subscriptionStatus: 2,
          },
          { merge: true }
        );
        res.json({
          stripeCustomerId: customerId,
          stripeSubId: subscriptionId,
          expiresAt: subcriptionObj.current_period_end,
        });
      }
    } else {
      res.json({
        message: "Duplicate transaction",
      });
    }
  } catch (e) {
    res.status(400);
    return res.send({
      error: {
        message: e.message,
      },
    });
  }
});

app.post("/hooks", async (request, response) => {
  let customerSubId;
  let customerId;
  let subcriptionObj;
  let event;
  event = request.body;
  console.log("event", event.body);
  // Handle the event
  switch (event.type) {
    case "invoice.payment_failed":
      console.log("invoice.payment_failed");
      break;

    case "customer.subscription.created":
      console.log("customer.subscription.created");
      break;

    case "customer.subscription.updated":
      customerSubId = event.data.object.id;
      customerId = event.data.object.customer;
      subcriptionObj = await stripe.subscriptions.retrieve(customerSubId);
      console.log("update doc");
      //find user with same subscription id and add customerid if subscription is still valid
      const userWithSameSubId = await adminDatabase
        .collectionGroup("users")
        .where("stripeSubId", "==", customerSubId)
        .get();
      console.log("updated doc", userWithSameSubId.docs[0].data());
      if (userWithSameSubId.docs.length === 1) {
        console.log("status", subcriptionObj);
        if (subcriptionObj.status === "active") {
          if (userWithSameSubId.docs[0].data().subscriptionStatus !== 1) {
            await adminDatabase
              .collection("users")
              .doc(userWithSameSubId.docs[0].data().id)
              .set(
                {
                  stripeCustomerId: customerId,
                  stripeSubId: customerSubId,
                  expiresAt: subcriptionObj.current_period_end,
                  subscriptionStatus: 2,
                },
                { merge: true }
              );
          }
        }

        if (
          subcriptionObj.status === "past_due" ||
          subcriptionObj.status === "canceled"
        ) {
          await stripe.subscriptions.del(customerSubId);
          await stripe.customers.del(customerId);

          await adminDatabase
            .collection("users")
            .doc(userWithSameSubId.docs[0].data().id)
            .set(
              {
                stripeCustomerId: null,
                stripeSubId: null,
                expiresAt: null,
                subscriptionStatus: 0,
              },
              { merge: true }
            );
        }
      }
      console.log("customer.subscription.updated");
      break;
    case "customer.subscription.deleted":
      customerSubId = event.data.object.id;
      customerId = event.data.object.customer;
      subcriptionObj = await stripe.subscriptions.retrieve(customerSubId);

      if (subcriptionObj.status === "canceled") {
        const userWithSameSubId = await adminDatabase
          .collectionGroup("users")
          .where("stripeSubId", "==", customerSubId)
          .get();

        if (userWithSameSubId.docs.length === 1) {
          await adminDatabase
            .collection("users")
            .doc(userWithSameSubId.docs[0].data().id)
            .set(
              {
                stripeCustomerId: null,
                stripeSubId: null,
                expiresAt: null,
                subscriptionStatus: 0,
              },
              { merge: true }
            );
        }
      }

      console.log("customer.subscription.deleted");

      break;
    // ... handle other event types
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  // Return a response to acknowledge receipt of the event
  response.json({ received: true });
});
const PORT = process.env.PORT || 3005;

app.listen(PORT, () => {
  console.log(`localhost:${PORT} server running`);
});
