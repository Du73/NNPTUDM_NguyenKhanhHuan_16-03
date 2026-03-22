var express = require('express');
var router = express.Router();
let mongoose = require('mongoose');

let { checkLogin } = require('../utils/authHandler');
let reservationModel = require('../schemas/reservations');
let cartModel = require('../schemas/carts');
let inventoryModel = require('../schemas/inventories');
let productModel = require('../schemas/products');

function normalizeItems(items) {
    let map = new Map();

    for (let item of items) {
        if (!item || !item.product) {
            continue;
        }

        let quantity = Number(item.quantity || 0);
        if (!Number.isFinite(quantity) || quantity <= 0) {
            continue;
        }

        let productId = String(item.product);
        let currentQty = map.get(productId) || 0;
        map.set(productId, currentQty + quantity);
    }

    return Array.from(map.entries()).map(function ([product, quantity]) {
        return { product: product, quantity: quantity };
    });
}

async function buildReservationFromItems(userId, rawItems, session) {
    let items = normalizeItems(rawItems);

    if (items.length === 0) {
        throw new Error('danh sach san pham khong hop le');
    }

    let productIds = items.map(function (e) {
        return e.product;
    });

    let products = await productModel.find({
        _id: { $in: productIds },
        isDeleted: false
    }).session(session);

    let inventories = await inventoryModel.find({
        product: { $in: productIds }
    }).session(session);

    let productMap = new Map();
    for (let product of products) {
        productMap.set(String(product._id), product);
    }

    let inventoryMap = new Map();
    for (let inventory of inventories) {
        inventoryMap.set(String(inventory.product), inventory);
    }

    let reservationItems = [];
    let totalAmount = 0;

    for (let item of items) {
        let product = productMap.get(String(item.product));
        if (!product) {
            throw new Error('san pham khong ton tai');
        }

        let inventory = inventoryMap.get(String(item.product));
        if (!inventory) {
            throw new Error('khong tim thay ton kho');
        }

        let available = inventory.stock - inventory.reserved;
        if (available < item.quantity) {
            throw new Error('khong du ton kho de dat truoc');
        }

        inventory.reserved += item.quantity;
        await inventory.save({ session: session });

        let subtotal = product.price * item.quantity;
        totalAmount += subtotal;

        reservationItems.push({
            product: product._id,
            quantity: item.quantity,
            title: product.title,
            price: product.price,
            subtotal: subtotal
        });
    }

    let newReservation = new reservationModel({
        user: userId,
        items: reservationItems,
        amount: totalAmount,
        status: 'actived',
        expiredIn: new Date(Date.now() + 15 * 60 * 1000)
    });

    await newReservation.save({ session: session });
    return newReservation;
}

// get all cua user -> get reservations/
router.get('/', checkLogin, async function (req, res, next) {
    let reservations = await reservationModel.find({
        user: req.userId
    }).sort({ _id: -1 });

    res.send(reservations);
});

// get 1 cua user -> get reservations/:id
router.get('/:id', checkLogin, async function (req, res, next) {
    try {
        let reservation = await reservationModel.findOne({
            _id: req.params.id,
            user: req.userId
        });

        if (!reservation) {
            res.status(404).send({
                message: 'reservation khong ton tai'
            });
            return;
        }

        res.send(reservation);
    } catch (error) {
        res.status(404).send({
            message: 'reservation khong ton tai'
        });
    }
});

// reserveACart -> post reserveACart/
router.post('/reserveACart', checkLogin, async function (req, res, next) {
    let session = await mongoose.startSession();
    session.startTransaction();

    try {
        let currentCart = await cartModel.findOne({
            user: req.userId
        }).session(session);

        if (!currentCart || currentCart.cartItems.length === 0) {
            throw new Error('gio hang trong');
        }

        let newReservation = await buildReservationFromItems(
            req.userId,
            currentCart.cartItems,
            session
        );

        currentCart.cartItems = [];
        await currentCart.save({ session: session });

        await session.commitTransaction();
        session.endSession();

        res.send(newReservation);
    } catch (error) {
        await session.abortTransaction();
        session.endSession();

        res.status(400).send({
            message: error.message
        });
    }
});

// reserveItems -> post reserveItems/ {body gom list product va quantity}
router.post('/reserveItems', checkLogin, async function (req, res, next) {
    let session = await mongoose.startSession();
    session.startTransaction();

    try {
        let items = req.body.items;
        let newReservation = await buildReservationFromItems(req.userId, items, session);

        await session.commitTransaction();
        session.endSession();

        res.send(newReservation);
    } catch (error) {
        await session.abortTransaction();
        session.endSession();

        res.status(400).send({
            message: error.message
        });
    }
});

// cancelReserve -> post cancelReserve/:id
router.post('/cancelReserve/:id', checkLogin, async function (req, res, next) {
    try {
        let reservation = await reservationModel.findOne({
            _id: req.params.id,
            user: req.userId
        });

        if (!reservation) {
            res.status(404).send({
                message: 'reservation khong ton tai'
            });
            return;
        }

        if (reservation.status !== 'actived') {
            res.status(400).send({
                message: 'reservation khong the huy'
            });
            return;
        }

        for (let item of reservation.items) {
            let inventory = await inventoryModel.findOne({
                product: item.product
            });

            if (inventory) {
                inventory.reserved = Math.max(0, inventory.reserved - item.quantity);
                await inventory.save();
            }
        }

        reservation.status = 'cancelled';
        await reservation.save();

        res.send(reservation);
    } catch (error) {
        res.status(400).send({
            message: error.message
        });
    }
});

module.exports = router;
