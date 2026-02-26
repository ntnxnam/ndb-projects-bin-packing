#!/bin/bash

# Automated Deployment Script for NDB Projects Bin Packing
# Deploys from local Mac to production server in one command

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
SERVER_USER="${DEPLOY_USER:-santhosh.s}"
SERVER_HOST="${DEPLOY_HOST:-ndb-qa.dev.nutanix.com}"
SERVER_PATH="/var/www/html/ndb-projects-bin-packing"
SERVER_PATH_FALLBACK="/home/${SERVER_USER}/ndb-projects-bin-packing"
PROJECT_NAME="ndb-projects-bin-packing"
APP_PORT="3847"

# Detect if we're inside the project directory or parent directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$(basename "$SCRIPT_DIR")" = "$PROJECT_NAME" ]; then
    # We're inside the project directory, go up one level
    WORKING_DIR="$(dirname "$SCRIPT_DIR")"
    PROJECT_DIR="$PROJECT_NAME"
else
    # We're in parent directory already
    WORKING_DIR="$SCRIPT_DIR"
    PROJECT_DIR="$PROJECT_NAME"
fi

# Functions
print_header() {
    echo -e "${CYAN}╔════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║  $1${NC}"
    echo -e "${CYAN}╚════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_step() {
    echo -e "${CYAN}▶ $1${NC}"
}

# Generate timestamp
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
ZIP_FILENAME="ndb-projects-bin-packing-${TIMESTAMP}.zip"

# Main deployment
main() {
    print_header "NDB Projects Bin Packing - Production Deployment           "
    
    echo -e "${BLUE}Deployment Details:${NC}"
    echo -e "  Source:      ${YELLOW}${WORKING_DIR}/${PROJECT_DIR}${NC}"
    echo -e "  Destination: ${YELLOW}${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}${NC}"
    echo -e "  Timestamp:   ${YELLOW}${TIMESTAMP}${NC}"
    echo -e "  Archive:     ${YELLOW}${ZIP_FILENAME}${NC}"
    echo -e "  Port:        ${YELLOW}${APP_PORT}${NC}"
    echo ""
    
    # Confirm deployment
    read -p "$(echo -e ${YELLOW}Continue with deployment? [y/N]: ${NC})" -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_warning "Deployment cancelled by user"
        exit 0
    fi
    echo ""
    
    # Change to working directory
    cd "$WORKING_DIR"
    
    # Step 1: Create zip archive
    print_step "Creating zip archive..."
    if [ -d "$PROJECT_DIR" ]; then
        # Create zip excluding unnecessary files
        zip -r "$ZIP_FILENAME" "$PROJECT_DIR" \
            -x "*/node_modules/*" \
            -x "*/.git/*" \
            -x "*/build/*" \
            -x "*/logs/*" \
            -x "*/.DS_Store" \
            -x "*/ndb-projects-bin-packing.log" \
            -x "*/*.log" \
            -x "*/agent-transcripts/*" \
            -x "*/.cursor/*" \
            > /dev/null 2>&1
        
        if [ $? -eq 0 ]; then
            ZIP_SIZE=$(du -h "$ZIP_FILENAME" | cut -f1)
            print_success "Archive created: ${ZIP_FILENAME} (${ZIP_SIZE})"
        else
            print_error "Failed to create zip archive"
            exit 1
        fi
    else
        print_error "Project directory not found: $PROJECT_DIR"
        print_info "Make sure you're running this script from the parent directory"
        exit 1
    fi
    
    # Step 2: Transfer to server
    print_step "Transferring to production server..."
    
    # First, determine which directory to use on the server
    ssh "${SERVER_USER}@${SERVER_HOST}" "mkdir -p ${SERVER_PATH} 2>/dev/null" && SERVER_DEPLOY_PATH="${SERVER_PATH}" || {
        print_warning "${SERVER_PATH} not writable, using ${SERVER_PATH_FALLBACK}"
        ssh "${SERVER_USER}@${SERVER_HOST}" "mkdir -p ${SERVER_PATH_FALLBACK}"
        SERVER_DEPLOY_PATH="${SERVER_PATH_FALLBACK}"
    }
    
    scp "$ZIP_FILENAME" "${SERVER_USER}@${SERVER_HOST}:${SERVER_DEPLOY_PATH}/"
    
    if [ $? -eq 0 ]; then
        print_success "Transfer complete"
    else
        print_error "Failed to transfer file to server"
        print_info "Check your SSH connection and credentials"
        # Clean up local zip
        rm -f "$ZIP_FILENAME"
        exit 1
    fi
    
    # Clean up local zip file
    print_info "Cleaning up local archive..."
    rm -f "$ZIP_FILENAME"
    print_success "Local archive removed"
    
    # Step 3: Deploy on server
    print_step "Deploying on production server..."
    echo ""
    
    ssh -t "${SERVER_USER}@${SERVER_HOST}" << ENDSSH
        set -e
        
        echo -e "${CYAN}▶ Navigating to deployment directory...${NC}"
        cd ${SERVER_DEPLOY_PATH}
        
        echo -e "${CYAN}▶ Backing up current version...${NC}"
        if [ -d "${PROJECT_NAME}" ]; then
            mv ${PROJECT_NAME} ${PROJECT_NAME}_backup_${TIMESTAMP}
            echo -e "${GREEN}✓ Backup created: ${PROJECT_NAME}_backup_${TIMESTAMP}${NC}"
        else
            echo -e "${YELLOW}⚠ No existing deployment found (fresh install)${NC}"
        fi
        
        echo -e "${CYAN}▶ Extracting new version...${NC}"
        unzip -q ${ZIP_FILENAME}
        if [ \$? -eq 0 ]; then
            echo -e "${GREEN}✓ Files extracted${NC}"
        else
            echo -e "${RED}✗ Failed to extract archive${NC}"
            exit 1
        fi
        
        echo -e "${CYAN}▶ Setting permissions...${NC}"
        chmod +x ${PROJECT_NAME}/*.sh
        echo -e "${GREEN}✓ Permissions set${NC}"
        
        echo -e "${CYAN}▶ Entering project directory...${NC}"
        cd ${PROJECT_NAME}
        
        echo -e "${CYAN}▶ Starting production server...${NC}"
        echo ""
        sh manage-production.sh
        
        echo ""
        echo -e "${GREEN}╔════════════════════════════════════════════════════════════════╗${NC}"
        echo -e "${GREEN}║           Deployment Completed Successfully!                   ║${NC}"
        echo -e "${GREEN}╚════════════════════════════════════════════════════════════════╝${NC}"
        echo ""
        echo -e "${BLUE}📦 Archive preserved on server: ${YELLOW}${ZIP_FILENAME}${NC}"
        echo -e "${BLUE}💾 Backup available at: ${YELLOW}${PROJECT_NAME}_backup_${TIMESTAMP}${NC}"
        echo ""
ENDSSH
    
    if [ $? -eq 0 ]; then
        echo ""
        print_success "Deployment completed successfully!"
        echo ""
        print_step "Verifying server status..."
        sleep 3
        
        # Check if port is reachable
        if nc -zv -w 5 "${SERVER_HOST}" "${APP_PORT}" 2>&1 | grep -q succeeded; then
            echo ""
            print_success "Port ${APP_PORT} is reachable"
            echo ""
            print_info "Application URL: ${GREEN}http://${SERVER_HOST}:${APP_PORT}${NC}"
        else
            echo ""
            print_warning "Port ${APP_PORT} not reachable from here (may need firewall/VPN)"
            print_info "If the app is running on the server, use SSH tunnel:"
            print_info "  ssh -L ${APP_PORT}:localhost:${APP_PORT} ${SERVER_USER}@${SERVER_HOST} -N"
            print_info "  Then open http://localhost:${APP_PORT} in your browser"
        fi
        
        echo ""
        print_info "Check server logs with:"
        print_info "  ssh ${SERVER_USER}@${SERVER_HOST} 'cat /tmp/ndb-projects-bin-packing.log'"
    else
        print_error "Deployment failed on server"
        print_info "The backup is still available on the server if rollback is needed"
        exit 1
    fi
}

# Check prerequisites
check_prerequisites() {
    # Change to working directory
    cd "$WORKING_DIR"
    
    # Check if project directory exists
    if [ ! -d "$PROJECT_DIR" ]; then
        print_error "Project directory not found: ${WORKING_DIR}/${PROJECT_DIR}"
        print_info "Script location: $SCRIPT_DIR"
        print_info "Working directory: $WORKING_DIR"
        exit 1
    fi
    
    # Check if zip is installed
    if ! command -v zip >/dev/null 2>&1; then
        print_error "zip command not found"
        print_info "Install with: brew install zip"
        exit 1
    fi
    
    # Check if scp is available
    if ! command -v scp >/dev/null 2>&1; then
        print_error "scp command not found"
        exit 1
    fi
    
    # Check if ssh is available
    if ! command -v ssh >/dev/null 2>&1; then
        print_error "ssh command not found"
        exit 1
    fi
    
    # Check if nc is available (for port checking)
    if ! command -v nc >/dev/null 2>&1; then
        print_warning "nc (netcat) not found - port verification will be skipped"
    fi
}

# Show help
show_help() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Automated deployment script for NDB Projects Bin Packing"
    echo ""
    echo "Options:"
    echo "  --help, -h     Show this help message"
    echo ""
    echo "Configuration:"
    echo "  Server:        ${SERVER_USER}@${SERVER_HOST}"
    echo "  Deploy Path:   ${SERVER_PATH}"
    echo "  Project Name:  ${PROJECT_NAME}"
    echo "  App Port:      ${APP_PORT}"
    echo ""
    echo "Environment Variables:"
    echo "  DEPLOY_USER    Override server username (default: santhosh.s)"
    echo "  DEPLOY_HOST    Override server hostname (default: ndb-qa.dev.nutanix.com)"
    echo ""
    echo "Usage:"
    echo "  Run from inside project: ./deploy-to-production.sh"
    echo "  Run from parent dir:     ./ndb-projects-bin-packing/deploy-to-production.sh"
    echo ""
    echo "What this script does:"
    echo "  1. Creates a timestamped zip archive of the project"
    echo "  2. Transfers it to the production server via SCP"
    echo "  3. Backs up the current version on the server"
    echo "  4. Extracts and deploys the new version"
    echo "  5. Runs manage-production.sh to start the server on port ${APP_PORT}"
    echo "  6. Verifies the deployment and provides access instructions"
    echo ""
    echo "Prerequisites:"
    echo "  - SSH access to production server"
    echo "  - zip command installed locally (brew install zip)"
    echo "  - Python 3 or Node.js/npx on the server"
    echo ""
    echo "Examples:"
    echo "  # Deploy with defaults"
    echo "  ./deploy-to-production.sh"
    echo ""
    echo "  # Deploy to different user/host"
    echo "  DEPLOY_USER=myuser DEPLOY_HOST=myserver.com ./deploy-to-production.sh"
    echo ""
}

# Parse arguments
if [[ "$1" == "--help" ]] || [[ "$1" == "-h" ]]; then
    show_help
    exit 0
fi

# Run deployment
check_prerequisites
main

