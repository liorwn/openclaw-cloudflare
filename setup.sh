#!/bin/bash
# OpenClaw Cloudflare Setup Script
# Interactive setup for deploying OpenClaw on Cloudflare Workers
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_header() {
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

print_step() {
    echo -e "${GREEN}▸ $1${NC}"
}

print_warn() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

# Cross-platform sed -i
sed_inplace() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "$@"
    else
        sed -i "$@"
    fi
}

# ============================================================
# Step 1: Check prerequisites
# ============================================================
print_header "OpenClaw Cloudflare Setup"

echo "Checking prerequisites..."

MISSING=""

# Check Node.js >= 22
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VERSION" -lt 22 ]; then
        MISSING="$MISSING\n  - Node.js >= 22 (found v$(node -v))"
    else
        print_step "Node.js $(node -v)"
    fi
else
    MISSING="$MISSING\n  - Node.js >= 22"
fi

# Check npm
if command -v npm &> /dev/null; then
    print_step "npm $(npm -v)"
else
    MISSING="$MISSING\n  - npm"
fi

# Check wrangler
if command -v npx &> /dev/null && npx wrangler --version &> /dev/null; then
    print_step "wrangler (via npx)"
else
    print_warn "wrangler not found — will be installed with npm install"
fi

# Check openssl
if command -v openssl &> /dev/null; then
    print_step "openssl"
else
    MISSING="$MISSING\n  - openssl (for token generation)"
fi

if [ -n "$MISSING" ]; then
    echo ""
    print_error "Missing prerequisites:$MISSING"
    echo ""
    echo "Please install the missing tools and re-run this script."
    exit 1
fi

echo ""

# ============================================================
# Step 2: Wrangler login
# ============================================================
print_header "Cloudflare Authentication"

echo "Checking wrangler authentication..."
if npx wrangler whoami 2>&1 | grep -q "You are logged in"; then
    print_step "Already authenticated with Cloudflare"
else
    echo "You need to authenticate with Cloudflare."
    echo "A browser window will open for you to log in."
    echo ""
    npx wrangler login
fi

echo ""

# ============================================================
# Step 3: Bot name
# ============================================================
print_header "Bot Configuration"

read -rp "Enter a name for your bot (e.g., my-assistant): " BOT_NAME

# Sanitize: lowercase, replace spaces with hyphens, remove non-alphanumeric
BOT_NAME=$(echo "$BOT_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-')

if [ -z "$BOT_NAME" ]; then
    BOT_NAME="my-openclaw-bot"
    print_warn "Using default name: $BOT_NAME"
fi

BUCKET_NAME="${BOT_NAME}-data"

print_step "Bot name: $BOT_NAME"
print_step "R2 bucket: $BUCKET_NAME"

# Update wrangler.jsonc
sed_inplace "s/\"my-openclaw-bot\"/\"$BOT_NAME\"/g" wrangler.jsonc
sed_inplace "s/\"my-openclaw-data\"/\"$BUCKET_NAME\"/g" wrangler.jsonc

# Update package.json name
sed_inplace "s/\"openclaw-cloudflare\"/\"$BOT_NAME\"/g" package.json

echo ""

# ============================================================
# Step 4: Create R2 bucket
# ============================================================
print_header "R2 Storage Bucket"

echo "Creating R2 bucket: $BUCKET_NAME"
if npx wrangler r2 bucket create "$BUCKET_NAME" 2>&1 | grep -qE "Created bucket|already exists"; then
    print_step "R2 bucket '$BUCKET_NAME' ready"
else
    print_warn "Could not create R2 bucket. You may need to create it manually."
    print_warn "Run: npx wrangler r2 bucket create $BUCKET_NAME"
fi

echo ""

# ============================================================
# Step 5: AI Provider
# ============================================================
print_header "AI Provider Configuration"

echo "Choose your AI provider:"
echo "  1) Anthropic (direct API key)"
echo "  2) OpenAI (direct API key)"
echo "  3) Cloudflare AI Gateway"
echo ""
read -rp "Enter choice [1-3]: " AI_CHOICE

case $AI_CHOICE in
    1)
        echo ""
        echo "Enter your Anthropic API key (starts with sk-ant-):"
        read -rsp "> " ANTHROPIC_KEY
        echo ""
        echo "$ANTHROPIC_KEY" | npx wrangler secret put ANTHROPIC_API_KEY
        print_step "Anthropic API key set"
        ;;
    2)
        echo ""
        echo "Enter your OpenAI API key (starts with sk-):"
        read -rsp "> " OPENAI_KEY
        echo ""
        echo "$OPENAI_KEY" | npx wrangler secret put OPENAI_API_KEY
        print_step "OpenAI API key set"
        ;;
    3)
        echo ""
        echo "Enter your AI Gateway API key (your provider's API key):"
        read -rsp "> " GW_API_KEY
        echo ""
        echo "$GW_API_KEY" | npx wrangler secret put CLOUDFLARE_AI_GATEWAY_API_KEY

        echo "Enter your Cloudflare Account ID:"
        read -rp "> " GW_ACCOUNT_ID
        echo "$GW_ACCOUNT_ID" | npx wrangler secret put CF_AI_GATEWAY_ACCOUNT_ID

        echo "Enter your AI Gateway ID:"
        read -rp "> " GW_GATEWAY_ID
        echo "$GW_GATEWAY_ID" | npx wrangler secret put CF_AI_GATEWAY_GATEWAY_ID

        print_step "AI Gateway configured"
        ;;
    *)
        print_warn "No AI provider configured. You'll need to set one manually."
        print_warn "Run: npx wrangler secret put ANTHROPIC_API_KEY"
        ;;
esac

echo ""

# ============================================================
# Step 6: Auto-generate gateway token and CDP secret
# ============================================================
print_header "Security Tokens"

GATEWAY_TOKEN=$(openssl rand -hex 32)
CDP_SECRET_VAL=$(openssl rand -hex 32)

echo "$GATEWAY_TOKEN" | npx wrangler secret put MOLTBOT_GATEWAY_TOKEN
print_step "Gateway token generated and set"

echo "$CDP_SECRET_VAL" | npx wrangler secret put CDP_SECRET
print_step "CDP secret generated and set"

echo ""

# ============================================================
# Step 7: Worker URL
# ============================================================
print_header "Worker URL"

echo "Your worker URL will be: https://${BOT_NAME}.<your-subdomain>.workers.dev"
echo "Enter your full worker URL (or press Enter to set it after deploy):"
read -rp "> " WORKER_URL_VAL

if [ -n "$WORKER_URL_VAL" ]; then
    echo "$WORKER_URL_VAL" | npx wrangler secret put WORKER_URL
    print_step "Worker URL set: $WORKER_URL_VAL"
else
    print_warn "Skipped. Set it later with: npx wrangler secret put WORKER_URL"
fi

echo ""

# ============================================================
# Step 8: Optional chat channels
# ============================================================
print_header "Chat Channels (Optional)"

read -rp "Set up Telegram? [y/N]: " SETUP_TELEGRAM
if [[ "$SETUP_TELEGRAM" =~ ^[Yy]$ ]]; then
    echo "Enter your Telegram bot token:"
    read -rsp "> " TELEGRAM_TOKEN
    echo ""
    echo "$TELEGRAM_TOKEN" | npx wrangler secret put TELEGRAM_BOT_TOKEN
    print_step "Telegram configured"
fi

read -rp "Set up Discord? [y/N]: " SETUP_DISCORD
if [[ "$SETUP_DISCORD" =~ ^[Yy]$ ]]; then
    echo "Enter your Discord bot token:"
    read -rsp "> " DISCORD_TOKEN
    echo ""
    echo "$DISCORD_TOKEN" | npx wrangler secret put DISCORD_BOT_TOKEN
    print_step "Discord configured"
fi

read -rp "Set up Slack? [y/N]: " SETUP_SLACK
if [[ "$SETUP_SLACK" =~ ^[Yy]$ ]]; then
    echo "Enter your Slack bot token:"
    read -rsp "> " SLACK_BOT
    echo ""
    echo "$SLACK_BOT" | npx wrangler secret put SLACK_BOT_TOKEN

    echo "Enter your Slack app token:"
    read -rsp "> " SLACK_APP
    echo ""
    echo "$SLACK_APP" | npx wrangler secret put SLACK_APP_TOKEN
    print_step "Slack configured"
fi

echo ""

# ============================================================
# Step 9: Optional R2 persistent storage credentials
# ============================================================
print_header "R2 Persistent Storage (Optional)"

echo "R2 persistent storage lets your bot's data survive container restarts."
echo "You need an R2 API token with Object Read & Write permissions."
echo ""
read -rp "Set up R2 persistence now? [y/N]: " SETUP_R2

if [[ "$SETUP_R2" =~ ^[Yy]$ ]]; then
    echo "Enter your R2 Access Key ID:"
    read -rsp "> " R2_KEY
    echo ""
    echo "$R2_KEY" | npx wrangler secret put R2_ACCESS_KEY_ID

    echo "Enter your R2 Secret Access Key:"
    read -rsp "> " R2_SECRET
    echo ""
    echo "$R2_SECRET" | npx wrangler secret put R2_SECRET_ACCESS_KEY

    echo "Enter your Cloudflare Account ID:"
    read -rp "> " CF_ACCT_ID
    echo "$CF_ACCT_ID" | npx wrangler secret put CF_ACCOUNT_ID

    print_step "R2 persistent storage configured"
else
    print_warn "Skipped. Your bot will work but data won't persist across restarts."
    print_warn "Set up later by following the R2 section in README.md."
fi

echo ""

# ============================================================
# Step 10: Install and deploy
# ============================================================
print_header "Install & Deploy"

print_step "Installing dependencies..."
npm install

print_step "Deploying to Cloudflare..."
npm run deploy

echo ""

# ============================================================
# Summary
# ============================================================
print_header "Setup Complete!"

echo "Your OpenClaw bot has been deployed."
echo ""
echo -e "${GREEN}Worker URL:${NC} https://${BOT_NAME}.<your-subdomain>.workers.dev"
echo -e "${GREEN}Control UI:${NC} https://${BOT_NAME}.<your-subdomain>.workers.dev/?token=${GATEWAY_TOKEN}"
echo -e "${GREEN}Admin UI:${NC}   https://${BOT_NAME}.<your-subdomain>.workers.dev/_admin/"
echo ""
echo -e "${YELLOW}IMPORTANT — Save your gateway token:${NC}"
echo "  $GATEWAY_TOKEN"
echo ""
echo -e "${YELLOW}IMPORTANT — Next steps:${NC}"
echo ""
echo "  1. Set up Cloudflare Access to protect your admin UI:"
echo "     - Go to Workers & Pages dashboard → select '${BOT_NAME}'"
echo "     - Settings → Domains & Routes → workers.dev → Enable Cloudflare Access"
echo "     - Then set the Access secrets:"
echo "       npx wrangler secret put CF_ACCESS_TEAM_DOMAIN"
echo "       npx wrangler secret put CF_ACCESS_AUD"
echo ""
echo "  2. Set your WORKER_URL (if you skipped it earlier):"
echo "     npx wrangler secret put WORKER_URL"
echo ""
echo "  3. Create a Cloudflare Access bypass for the /cdp path:"
echo "     - Go to Zero Trust → Access → Applications"
echo "     - Create a NEW self-hosted application for the /cdp path"
echo "     - Set the domain to: ${BOT_NAME}.<your-subdomain>.workers.dev"
echo "     - Set the path to: /cdp"
echo "     - Add a Service Auth policy (or Bypass) so the container can reach /cdp"
echo "     - Without this, browser automation will fail with 'Access denied'"
echo ""
echo "  4. Pair your device via the admin UI at /_admin/"
echo ""
echo "For full documentation, see README.md"
