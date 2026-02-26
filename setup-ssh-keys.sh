#!/bin/bash

# SSH Key Setup Script for NDB Projects Bin Packing
# Sets up passwordless SSH authentication to production server

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Configuration (with environment variable overrides)
SERVER_USER="${DEPLOY_USER:-santhosh.s}"
SERVER_HOST="${DEPLOY_HOST:-ndb-qa.dev.nutanix.com}"

echo -e "${CYAN}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  SSH Key Setup for Passwordless Authentication                 ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════════════════════╝${NC}"
echo ""

echo -e "${BLUE}This will set up SSH key authentication to:${NC}"
echo -e "  ${YELLOW}${SERVER_USER}@${SERVER_HOST}${NC}"
echo ""
echo -e "${BLUE}Environment Variables:${NC}"
echo -e "  DEPLOY_USER: ${YELLOW}${SERVER_USER}${NC}"
echo -e "  DEPLOY_HOST: ${YELLOW}${SERVER_HOST}${NC}"
echo ""

# Check if SSH key already exists
if [ -f ~/.ssh/id_rsa.pub ] || [ -f ~/.ssh/id_ed25519.pub ]; then
    echo -e "${GREEN}✓ SSH key already exists${NC}"
    
    if [ -f ~/.ssh/id_ed25519.pub ]; then
        echo -e "${BLUE}  Key type: ${YELLOW}ed25519${NC}"
        echo -e "${BLUE}  Location: ${YELLOW}~/.ssh/id_ed25519.pub${NC}"
    elif [ -f ~/.ssh/id_rsa.pub ]; then
        echo -e "${BLUE}  Key type: ${YELLOW}RSA${NC}"
        echo -e "${BLUE}  Location: ${YELLOW}~/.ssh/id_rsa.pub${NC}"
    fi
else
    echo -e "${YELLOW}⚠ No SSH key found. Generating new SSH key...${NC}"
    echo -e "${BLUE}  Key type: ed25519 (recommended)${NC}"
    echo ""
    ssh-keygen -t ed25519 -C "${SERVER_USER}@${SERVER_HOST}" -f ~/.ssh/id_ed25519 -N ""
    echo ""
    echo -e "${GREEN}✓ SSH key generated${NC}"
fi

# Copy SSH key to server
echo ""
echo -e "${CYAN}▶ Copying SSH key to server...${NC}"
echo -e "${YELLOW}You will be prompted for your password ONE LAST TIME${NC}"
echo ""

# Determine which key to copy
if [ -f ~/.ssh/id_ed25519.pub ]; then
    KEY_FILE=~/.ssh/id_ed25519.pub
elif [ -f ~/.ssh/id_rsa.pub ]; then
    KEY_FILE=~/.ssh/id_rsa.pub
else
    echo -e "${RED}✗ No SSH public key found${NC}"
    exit 1
fi

# Check if ssh-copy-id is available
if command -v ssh-copy-id >/dev/null 2>&1; then
    ssh-copy-id -i "$KEY_FILE" "${SERVER_USER}@${SERVER_HOST}"
else
    # Manual copy if ssh-copy-id is not available
    echo -e "${YELLOW}⚠ ssh-copy-id not found, using manual method${NC}"
    cat "$KEY_FILE" | ssh "${SERVER_USER}@${SERVER_HOST}" "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
fi

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║              SSH Key Setup Complete!                           ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${GREEN}✓ You can now SSH without password!${NC}"
    echo ""
    echo -e "${BLUE}Test your connection:${NC}"
    echo -e "  ${YELLOW}ssh ${SERVER_USER}@${SERVER_HOST}${NC}"
    echo ""
    echo -e "${BLUE}Now you can run deployments without password prompts:${NC}"
    echo -e "  ${YELLOW}./deploy-to-production.sh${NC}"
    echo ""
else
    echo ""
    echo -e "${RED}✗ Failed to copy SSH key${NC}"
    echo ""
    echo -e "${YELLOW}Troubleshooting:${NC}"
    echo -e "  1. Verify you have SSH access: ${YELLOW}ssh ${SERVER_USER}@${SERVER_HOST}${NC}"
    echo -e "  2. Check server allows key authentication in /etc/ssh/sshd_config"
    echo -e "  3. Verify the server's ~/.ssh directory permissions (should be 700)"
    echo ""
    exit 1
fi

