// Handle CORS preflight checks
export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        },
    });
}
// Helper function to send Telegram notification to a single Chat ID
const sendTelegramNotification = async (botToken, chatId, message) => {
    return fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML'
        })
    });
};
export async function onRequestPost(context) {
    try {
        const data = await context.request.json();

        const {
            fullName,
            phone,
            secondaryPhone,
            address,
            product,
            totalPrice,
            paymentMethod
        } = data;

        const orderNumber = 'GLM-' + Math.floor(1000 + Math.random() * 9000);

        // 1. Save order directly into Cloudflare D1 Database
        // 2. Dispatch notification to Telegram
        const esc = (s) =>
            String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

        const BOT_TOKEN = context.env.BOT_TOKEN;
        const CHAT_IDS = ["1064909679", "5862823421"];

        const telegramMessage =
            `💵 <b>NEW ORDER: ${esc(orderNumber)}</b>\n\n` +
            `👤 <b>Customer:</b> ${esc(fullName)}\n` +
            `📞 <b>Phone:</b> ${esc(phone)}\n` +
            (secondaryPhone ? `📱 <b>Alt Phone:</b> ${esc(secondaryPhone)}\n` : "") +
            `📍 <b>Address:</b> ${esc(address)}\n\n` +
            `📦 <b>Items:</b> ${esc(product)}\n\n` +
            `💳 <b>Payment:</b> ${esc(paymentMethod)}\n` +
            `💰 <b>Total:</b> ${esc(totalPrice)}`;


        if (BOT_TOKEN && CHAT_IDS.length > 0) {
            const results = await Promise.allSettled(
                CHAT_IDS.map(async (chatId) => {
                    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: chatId,
                            text: telegramMessage,
                            parse_mode: 'HTML'
                        })
                    });
                    if (!res.ok) throw new Error(`Chat ${chatId}: ${res.status} ${await res.text()}`);
                })
            );
            results.forEach((r) => r.status === 'rejected' && console.error('Telegram error:', r.reason));
        } else {
            console.error('BOT_TOKEN is missing. Check the secret in Cloudflare.');
        }
        return new Response(JSON.stringify({ success: true, orderNumber }), {
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        });

    } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        });
    }
}