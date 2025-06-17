// orderService.js
const AWS = require('aws-sdk');
const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');

const eventBridge = new AWS.EventBridge();

const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
};


exports.handler = async (event) => {
  console.log('Received create-order request:', JSON.stringify(event));

  const { orderId = uuidv4(), customerId, items, paymentMethod } = JSON.parse(event.body);

  if (!customerId || !items?.length || !paymentMethod) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid request payload' }),
    };
  }

  try {
    const connection = await mysql.createConnection(dbConfig);
    await connection.beginTransaction();

    // Save order
    const [orderResult] = await connection.execute(
      `INSERT INTO orders (order_id, customer_id, payment_method, status) VALUES (?, ?, ?, ?)`,
      [orderId, customerId, paymentMethod, 'PENDING']
    );

    // Save each item in order_items
    for (const item of items) {
      const { productId, quantity, price } = item;
      await connection.execute(
        `INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)`,
        [orderId, productId, quantity, price]
      );
    }

    await connection.commit();
    await connection.end();
    console.log(`Order ${orderId} saved successfully`);

  } catch (err) {
    console.error('Failed to save order', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error while saving order' }),
    };
  }

  const orderEvent = {
    Source: 'ecommerce.order',
    DetailType: 'OrderCreated',
    Detail: JSON.stringify({ orderId, customerId, items, paymentMethod }),
    EventBusName: 'default',
  };

  try {
    // Enqueue the order Lambda
    await eventBridge.putEvents({ Entries: [orderEvent] }).promise();
    console.log(`Published OrderCreated for orderId=${orderId}`);
    return {
      statusCode: 202,
      body: JSON.stringify({
        orderId,
        status: 'PENDING',
        message: 'Order accepted and processing',
      }),
    };
  } catch (err) {
    console.error('Failed to publish order event', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
