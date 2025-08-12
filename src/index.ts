import { Hono } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import playwright from 'playwright-aws-lambda'
import chromium from '@sparticuz/chromium'
import type { Browser, Page } from 'playwright-core'

const app = new Hono()

// Types for the scraper service
interface ScraperRequest {
  retailer: string
  auth: {
    type: 'oauth' | 'credentials'
    token?: string
    username?: string
    password?: string
  }
  date_range?: {
    start_date: string
    end_date: string
  }
  import_options?: {
    include_returns: boolean
    include_digital: boolean
    include_subscriptions: boolean
  }
}

interface ScrapedProduct {
  external_id: string
  name: string
  price: number
  purchase_date: string
  image_url?: string | undefined
  retailer: string
  category?: string | undefined
}

// Amazon-specific interfaces
interface AmazonOrder {
  order_id: string
  order_date: string
  product_name: string
  product_url: string
  product_image: string
  price: number
  currency: string
  purchase_location: string
}

// Raw product data from page extraction
interface RawProductData {
  external_id: string
  name: string
  price_text: string
  purchase_date: string
  image_url: string | null | undefined
  retailer: string
}

// Raw Amazon order data from page extraction
interface RawAmazonOrderData {
  order_id: string
  order_date: string
  product_name: string
  product_url: string
  product_image: string
  price_text: string
  currency: string
  purchase_location: string
}

// Selector configuration type
interface RetailerSelectors {
  loginEmail: string
  loginPassword: string
  loginSubmit: string
  ordersPage: string
  orderCards: string
  productName: string
  orderDate: string
  productPrice: string
  productImage: string
  nextPage: string
  captcha: string
  twoFactor: string
}

// Error handling class
class ScrapingError extends Error {
  type: 'CAPTCHA' | 'AUTH_FAILED' | 'PARSE_ERROR' | 'RATE_LIMIT' | 'TIMEOUT'
  recoverable: boolean
  order_id?: string | undefined

  constructor(
    type: 'CAPTCHA' | 'AUTH_FAILED' | 'PARSE_ERROR' | 'RATE_LIMIT' | 'TIMEOUT',
    message: string,
    recoverable: boolean,
    order_id?: string | undefined
  ) {
    super(message)
    this.name = 'ScrapingError'
    this.type = type
    this.recoverable = recoverable
    this.order_id = order_id
  }
}

// Constants and configurations
const SELECTOR_FALLBACKS = {
  orderCard: [
    '[data-test-id="order-card"]',
    '.order-card',
    '.a-box.shipment',
    '.order-info',
    '.order'
  ],
  productName: [
    '.product-title a',
    '.item-title',
    'a[href*="/dp/"]',
    '.a-link-normal',
    '.item-view-left-col-inner a'
  ],
  orderDate: [
    '.order-date',
    '.order-placed-date',
    '[data-test-id="order-date"]',
    '.order-info .a-color-secondary'
  ],
  orderTotal: [
    '.order-total',
    '.grand-total-price',
    '.a-price-whole',
    '.order-summary-total'
  ]
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'
]

// Utility functions
function sanitizeString(input: string): string {
  if (!input) return ''
  
  return input
    .trim()
    .replace(/[<>]/g, '') // Remove potential HTML
    .replace(/[^\w\s\-.,()]/g, '') // Allow only safe characters
    .substring(0, 255) // Limit length
}

function parseAmazonDate(dateStr: string): string {
  try {
    const date = new Date(dateStr)
    const result = date.toISOString().split('T')[0]
    return result || ''
  } catch {
    const fallback = new Date().toISOString().split('T')[0]
    return fallback || ''
  }
}

function parsePrice(priceStr: string): number {
  if (!priceStr) return 0
  
  const match = priceStr.match(/[\d,]+\.?\d*/)
  if (match) {
    return parseFloat(match[0].replace(/,/g, ''))
  }
  
  return 0
}

function extractBrandFromName(productName: string): string {
  const words = productName.split(' ')
  return words[0] || 'Unknown'
}

// Browser management
async function launchSecureBrowser(): Promise<Browser> {
  const executablePath = await chromium.executablePath()

  const browser = await playwright.launchChromium({
    args: chromium.args,
    executablePath,
    headless: true,
  })

  return browser
}

async function cleanupResources(browser: Browser | null, page: Page | null): Promise<void> {
  try {
    if (page && !page.isClosed()) {
      await page.close()
    }
    
    if (browser && browser.isConnected()) {
      await browser.close()
    }
  } catch (error) {
    console.error('Cleanup error:', error)
  }
  
  if (global.gc) {
    global.gc()
  }
}

// Amazon scraping functions
async function handleCaptchaDetection(page: Page): Promise<void> {
  const captchaSelectors = [
    '#captchacharacters',
    '.cvf-widget-container',
    '[name="cvf_captcha_input"]',
    '#auth-captcha-image',
    '.captcha-container'
  ]
  
  for (const selector of captchaSelectors) {
    if (await page.$(selector)) {
      throw new ScrapingError(
        'CAPTCHA',
        'Amazon requires manual verification. Please try again later.',
        false
      )
    }
  }
}

async function authenticateWithAmazon(page: Page, accessToken: string): Promise<void> {
  try {
    const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] || USER_AGENTS[0]
    
    await page.context().addInitScript((ua: string) => {
      Object.defineProperty(navigator, 'userAgent', {
        get: () => ua,
      })
    }, userAgent)
    
    await page.setViewportSize({ width: 1280, height: 720 })
    
    await page.setExtraHTTPHeaders({
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'User-Agent': userAgent || ''
    })
    
    await page.addInitScript((token: string) => {
      localStorage.setItem('amazon_access_token', token)
      sessionStorage.setItem('auth_state', 'authenticated')
      document.cookie = `amazon_auth_token=${token}; domain=.amazon.com; path=/`
    }, accessToken)
    
    await page.goto('https://www.amazon.com', {
      waitUntil: 'networkidle',
      timeout: 30000
    })
    
    await page.goto('https://www.amazon.com/gp/css/homepage.html', {
      waitUntil: 'networkidle',
      timeout: 30000
    })
    
    await handleCaptchaDetection(page)
    
    const accountIndicators = [
      '[data-test-id="nav-your-account"]',
      '#nav-link-accountList',
      '.nav-line-1-container'
    ]
    
    let authenticated = false
    for (const selector of accountIndicators) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 })
        authenticated = true
        break
      } catch {
        continue
      }
    }
    
    if (!authenticated) {
      throw new Error('Failed to verify authentication with Amazon')
    }
    
  } catch (error) {
    if ((error as Error).message.includes('CAPTCHA')) {
      throw new ScrapingError('CAPTCHA', 'Amazon requires CAPTCHA verification', false)
    }
    throw new ScrapingError('AUTH_FAILED', `Authentication failed: ${(error as Error).message}`, false)
  }
}

async function extractOrdersWithPagination(
  page: Page,
  options: { max_pages: number }
): Promise<AmazonOrder[]> {
  const allOrders: AmazonOrder[] = []
  let currentPage = 1
  let hasNextPage = true
  const maxPages = Math.min(options.max_pages || 10, 20)
  
  while (hasNextPage && currentPage <= maxPages) {
    try {
      console.log(`Scraping page ${currentPage}...`)
      
      await page.waitForSelector(SELECTOR_FALLBACKS.orderCard[0] || '.order-card', { timeout: 15000 })
      
      const pageOrders = await page.evaluate(
        (fallbacks) => {
          const orders: RawAmazonOrderData[] = []
          const orderCards = document.querySelectorAll(fallbacks.orderCard.join(', '))
          
          orderCards.forEach((card, cardIndex) => {
            try {
              const orderHeader = card.querySelector('.order-header') || card
              const orderDateEl = orderHeader.querySelector('.order-date, .order-info .a-color-secondary')
              const orderTotalEl = orderHeader.querySelector('.order-total, .grand-total-price, .a-price-whole')
              const orderNumberEl = orderHeader.querySelector('.order-number, [data-test-id="order-number"]')
              
              const orderDate = orderDateEl?.textContent?.trim() || ''
              const orderTotal = orderTotalEl?.textContent?.trim() || ''
              const orderNumber = orderNumberEl?.textContent?.trim() || ''
              
              const itemElements = card.querySelectorAll('.item-view-left-col-inner, .item-row, .product-row')
              
              itemElements.forEach((item, index) => {
                const productLink = item.querySelector('a[href*="/dp/"], a[href*="/product/"]')
                const productName = productLink?.textContent?.trim() ||
                                  item.querySelector('.item-title, .product-title')?.textContent?.trim()
                const productUrl = productLink?.getAttribute('href')
                const productImage = item.querySelector('img')?.getAttribute('src') || ''
                const itemPrice = item.querySelector('.item-price, .a-price-whole, .price')?.textContent?.trim() || orderTotal
                
                if (productName && orderDate) {
                  orders.push({
                    order_id: orderNumber || `${Date.now()}-${cardIndex}-${index}`,
                    order_date: orderDate,
                    product_name: productName,
                    product_url: productUrl ? (productUrl.startsWith('http') ? productUrl : `https://amazon.com${productUrl}`) : '',
                    product_image: productImage,
                    price_text: itemPrice,
                    currency: 'USD',
                    purchase_location: 'Amazon'
                  })
                }
              })
            } catch (itemError) {
              console.error('Error extracting item:', itemError)
            }
          })
          
          return orders
        },
        SELECTOR_FALLBACKS
      )
      
      const processedOrders = pageOrders.map(order => ({
        order_id: sanitizeString(order.order_id),
        order_date: parseAmazonDate(order.order_date),
        product_name: sanitizeString(order.product_name),
        product_url: order.product_url || '',
        product_image: order.product_image || '',
        price: parsePrice(order.price_text),
        currency: order.currency || 'USD',
        purchase_location: order.purchase_location || 'Amazon'
      }))
      
      allOrders.push(...processedOrders)
      console.log(`Extracted ${processedOrders.length} items from page ${currentPage}`)
      
      const nextButton = await page.$('[data-test-id="pagination-next"]:not([disabled]), .a-pagination .a-last:not(.a-disabled)')
      
      if (nextButton && currentPage < maxPages) {
        await nextButton.click()
        await page.waitForLoadState('networkidle')
        currentPage++
        await page.waitForTimeout(2000 + Math.random() * 1000)
      } else {
        hasNextPage = false
      }
      
    } catch (pageError) {
      console.error(`Error on page ${currentPage}:`, pageError)
      
      if ((pageError as Error).message.includes('CAPTCHA')) {
        throw new ScrapingError('CAPTCHA', 'Amazon presented CAPTCHA during scraping', false)
      }
      
      hasNextPage = false
    }
  }
  
  return allOrders
}

// Amazon scraping with date range and import options support
async function scrapeAmazonWithOAuth(
  accessToken: string, 
  dateRange?: { start_date: string; end_date: string },
  importOptions?: {
    include_returns: boolean;
    include_digital: boolean;
    include_subscriptions: boolean;
  }
): Promise<ScrapedProduct[]> {
  let browser: Browser | null = null
  let page: Page | null = null

  const timeoutHandle = setTimeout(() => {
    throw new Error('Function timeout exceeded')
  }, 4 * 60 * 1000)

  try {
    if (!accessToken || accessToken.length < 10) {
      throw new Error('Invalid access token format')
    }
    
    browser = await launchSecureBrowser()
    page = await browser.newPage()
    
    await authenticateWithAmazon(page, accessToken)
    
    // Navigate to orders page with date filters if provided
    let ordersUrl = 'https://www.amazon.com/gp/css/order-history'
    if (dateRange) {
      const params = new URLSearchParams()
      params.set('orderFilter', 'year-' + new Date(dateRange.start_date).getFullYear())
      ordersUrl += '?' + params.toString()
    }
    
    await page.goto(ordersUrl, {
      waitUntil: 'networkidle',
      timeout: 30000
    })
    
    // Apply additional filters based on import options
    if (importOptions) {
      try {
        // Filter for returns if excluded
        if (!importOptions.include_returns) {
          const returnFilter = await page.$('input[value="returns"]')
          if (returnFilter && await returnFilter.isChecked()) {
            await returnFilter.uncheck()
            await page.waitForLoadState('networkidle')
          }
        }
        
        // Filter for digital items if excluded
        if (!importOptions.include_digital) {
          const digitalFilter = await page.$('input[value="digital"]')
          if (digitalFilter && await digitalFilter.isChecked()) {
            await digitalFilter.uncheck()
            await page.waitForLoadState('networkidle')
          }
        }
        
        // Filter for subscriptions if excluded
        if (!importOptions.include_subscriptions) {
          const subscriptionFilter = await page.$('input[value="subscription"]')
          if (subscriptionFilter && await subscriptionFilter.isChecked()) {
            await subscriptionFilter.uncheck()
            await page.waitForLoadState('networkidle')
          }
        }
      } catch (filterError) {
        console.warn('Could not apply import filters:', filterError)
        // Continue without filters rather than failing
      }
    }
    
    const orders = await extractOrdersWithPagination(page, { max_pages: 10 })
    
    // Filter orders by date range if provided
    let filteredOrders = orders
    if (dateRange) {
      const startDate = new Date(dateRange.start_date)
      const endDate = new Date(dateRange.end_date)
      
      filteredOrders = orders.filter(order => {
        const orderDate = new Date(order.order_date)
        return orderDate >= startDate && orderDate <= endDate
      })
    }
    
    // Convert Amazon orders to ScrapedProduct format
    const scrapedProducts: ScrapedProduct[] = filteredOrders.map(order => ({
      external_id: order.order_id,
      name: order.product_name,
      price: order.price,
      purchase_date: order.order_date,
      image_url: order.product_image ? order.product_image : undefined,
      retailer: 'amazon',
      category: extractBrandFromName(order.product_name)
    }))
    
    return scrapedProducts
    
  } finally {
    clearTimeout(timeoutHandle)
    await cleanupResources(browser, page)
  }
}

// Walmart scraping selectors and configurations
const WALMART_SELECTORS: RetailerSelectors = {
  loginEmail: '#sign-in-email',
  loginPassword: '#sign-in-password',
  loginSubmit: 'button[data-automation-id="signin-submit-btn"]',
  ordersPage: 'a[href*="/orders"]',
  orderCards: '[data-automation-id="order-card"], .order-card, .order-item',
  productName: '[data-automation-id="product-title"], .product-title, .item-title',
  orderDate: '[data-automation-id="order-date"], .order-date, .date',
  productPrice: '[data-automation-id="product-price"], .price, .item-price',
  productImage: 'img[data-automation-id="product-image"], .product-image img',
  nextPage: '[data-automation-id="pagination-next"], .paginator-btn:last-child',
  captcha: '#funcaptcha, .captcha, [data-automation-id="captcha"]',
  twoFactor: '[data-automation-id="verification-code"], #two-step-verification'
}

// Target scraping selectors
const TARGET_SELECTORS: RetailerSelectors = {
  loginEmail: '#username',
  loginPassword: '#password',
  loginSubmit: '#login',
  ordersPage: 'a[href*="/orders"], a[href*="/account/orders"]',
  orderCards: '.order-card, [data-test="order-card"], .order-item',
  productName: '[data-test="product-title"], .product-title, .item-name',
  orderDate: '[data-test="order-date"], .order-date, .date-placed',
  productPrice: '[data-test="product-price"], .price, .item-price',
  productImage: '[data-test="product-image"] img, .product-image img',
  nextPage: '[data-test="next-page"], .next-page, .pagination-next',
  captcha: '.recaptcha, #captcha, [data-test="captcha"]',
  twoFactor: '[data-test="verification-code"], #verification-code'
}

// Best Buy scraping selectors  
const BESTBUY_SELECTORS: RetailerSelectors = {
  loginEmail: '#fld-e',
  loginPassword: '#fld-p1',
  loginSubmit: 'button[type="submit"]',
  ordersPage: 'a[href*="/profile/orders"]',
  orderCards: '.order-card, .order-item, [data-testid="order-card"]',
  productName: '.order-item-title, .product-title, [data-testid="product-title"]',
  orderDate: '.order-date, [data-testid="order-date"]',
  productPrice: '.order-item-price, .price, [data-testid="product-price"]',
  productImage: '.order-item-image img, .product-image img',
  nextPage: '.sr-only:contains("Next"), .pagination-next',
  captcha: '.g-recaptcha, #captcha',
  twoFactor: '#verificationCode, [data-testid="verification-code"]'
}

// Generic retailer authentication function
async function authenticateWithRetailer(
  page: Page, 
  username: string | undefined, 
  password: string | undefined, 
  selectors: RetailerSelectors,
  retailerName: string,
  loginUrl: string
): Promise<void> {
  try {
    // Set random user agent
    const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] || USER_AGENTS[0]
    await page.context().addInitScript((ua: string) => {
      Object.defineProperty(navigator, 'userAgent', {
        get: () => ua,
      })
    }, userAgent)
    
    await page.setViewportSize({ width: 1280, height: 720 })
    
    // Navigate to login page
    await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 30000 })
    
    // Check for CAPTCHA before login
    if (await page.$(selectors.captcha)) {
      throw new ScrapingError('CAPTCHA', `${retailerName} requires CAPTCHA verification`, false)
    }
    
    // Fill login form
    await page.waitForSelector(selectors.loginEmail, { timeout: 15000 })
    await page.fill(selectors.loginEmail, username ?? '')
    await page.fill(selectors.loginPassword, password ?? '')
    
    // Submit login form
    await page.click(selectors.loginSubmit)
    await page.waitForLoadState('networkidle')
    
    // Check for 2FA
    if (await page.$(selectors.twoFactor)) {
      throw new ScrapingError('AUTH_FAILED', `${retailerName} requires two-factor authentication`, false)
    }
    
    // Check for post-login CAPTCHA
    if (await page.$(selectors.captcha)) {
      throw new ScrapingError('CAPTCHA', `${retailerName} requires CAPTCHA verification after login`, false)
    }
    
    // Verify successful login by checking for account elements or absence of login form
    const isStillOnLogin = await page.$(selectors.loginEmail)
    if (isStillOnLogin) {
      throw new ScrapingError('AUTH_FAILED', `${retailerName} login failed - credentials may be incorrect`, false)
    }
    
    console.log(`Successfully authenticated with ${retailerName}`)
    
  } catch (error) {
    if (error instanceof ScrapingError) {
      throw error
    }
    throw new ScrapingError('AUTH_FAILED', `${retailerName} authentication failed: ${(error as Error).message}`, false)
  }
}

// Generic order extraction function
async function extractOrdersFromRetailer(
  page: Page,
  selectors: RetailerSelectors,
  retailerName: string,
  ordersUrl: string,
  maxPages: number = 5
): Promise<ScrapedProduct[]> {
  const allProducts: ScrapedProduct[] = []
  let currentPage = 1
  
  try {
    // Navigate to orders page
    await page.goto(ordersUrl, { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForSelector(selectors.orderCards, { timeout: 15000 })
    
    while (currentPage <= maxPages) {
      console.log(`Scraping ${retailerName} page ${currentPage}...`)
      
      // Extract orders from current page
      const pageProducts = await page.evaluate(
        (selectors: RetailerSelectors): RawProductData[] => {
          const products: RawProductData[] = []
          const orderElements = document.querySelectorAll(selectors.orderCards)
          
          orderElements.forEach((orderCard, index) => {
            try {
              const productNameEl = orderCard.querySelector(selectors.productName)
              const orderDateEl = orderCard.querySelector(selectors.orderDate)  
              const productPriceEl = orderCard.querySelector(selectors.productPrice)
              const productImageEl = orderCard.querySelector(selectors.productImage)
              
              const productName = productNameEl?.textContent?.trim()
              const orderDate = orderDateEl?.textContent?.trim() || orderDateEl?.getAttribute('datetime')
              const productPrice = productPriceEl?.textContent?.trim()
              const productImage = productImageEl?.getAttribute('src')
              
              if (productName && orderDate) {
                products.push({
                  external_id: `${retailerName}_${Date.now()}_${index}`,
                  name: productName,
                  price_text: productPrice || '0',
                  purchase_date: orderDate,
                  image_url: productImage || null,
                  retailer: retailerName
                })
              }
            } catch (itemError) {
              console.error('Error extracting item:', itemError)
            }
          })
          
          return products
        },
        selectors
      )
      
      // Process the extracted data
      const processedProducts: ScrapedProduct[] = pageProducts.map(product => ({
        external_id: product.external_id,
        name: sanitizeString(product.name),
        price: parsePrice(product.price_text),
        purchase_date: parseRetailerDate(product.purchase_date),
        image_url: product.image_url || undefined,
        retailer: retailerName.toLowerCase(),
        category: extractBrandFromName(product.name)
      }))
      
      allProducts.push(...processedProducts)
      console.log(`Extracted ${processedProducts.length} items from ${retailerName} page ${currentPage}`)
      
      // Check for next page
      const nextButton = await page.$(selectors.nextPage)
      if (nextButton && currentPage < maxPages) {
        await nextButton.click()
        await page.waitForLoadState('networkidle')
        currentPage++
        await page.waitForTimeout(2000 + Math.random() * 1000) // Random delay
      } else {
        break
      }
    }
    
  } catch (error) {
    console.error(`Error extracting ${retailerName} orders:`, error)
    throw new ScrapingError('PARSE_ERROR', `Failed to extract ${retailerName} orders: ${(error as Error).message}`, true)
  }
  
  return allProducts
}

// Date parsing helper for different retailer formats
function parseRetailerDate(dateStr: string): string {
  if (!dateStr) {
    const fallback = new Date().toISOString().split('T')[0]
    return fallback || ''
  }
  
  try {
    // Clean up the date string
    const cleaned = dateStr.replace(/[^\w\s,.-]/g, '').trim()
    
    // Handle various date formats
    const date = new Date(cleaned)
    if (!isNaN(date.getTime())) {
      const result = date.toISOString().split('T')[0]
      return result || ''
    }
    
    // Try to parse relative dates like "2 days ago"
    if (cleaned.includes('day') || cleaned.includes('week') || cleaned.includes('month')) {
      const now = new Date()
      const match = cleaned.match(/(\d+)\s*(day|week|month)/)
      if (match && match[1] && match[2]) {
        const amount = parseInt(match[1])
        const unit = match[2]
        
        if (unit === 'day') {
          now.setDate(now.getDate() - amount)
        } else if (unit === 'week') {
          now.setDate(now.getDate() - (amount * 7))
        } else if (unit === 'month') {
          now.setMonth(now.getMonth() - amount)
        }
        
        const result = now.toISOString().split('T')[0]
        return result || ''
      }
    }
    
  } catch (error) {
    console.error('Date parsing error:', error)
  }
  
  // Fallback to current date
  const fallback = new Date().toISOString().split('T')[0]
  return fallback || ''
}

// Walmart scraping function - IMPLEMENTED
async function importFromWalmart(username: string | undefined, password: string | undefined): Promise<ScrapedProduct[]> {
  let browser: Browser | null = null
  let page: Page | null = null

  try {
    browser = await launchSecureBrowser()
    page = await browser.newPage()
    
    // Authenticate with Walmart
    await authenticateWithRetailer(
      page, 
      username, 
      password, 
      WALMART_SELECTORS,
      'Walmart',
      'https://www.walmart.com/account/login'
    )
    
    // Extract orders
    const products = await extractOrdersFromRetailer(
      page,
      WALMART_SELECTORS,
      'Walmart',
      'https://www.walmart.com/orders',
      5 // Max 5 pages
    )
    
    return products
    
  } catch (error) {
    console.error('Walmart scraping error:', error)
    if (error instanceof ScrapingError) {
      throw error
    }
    throw new ScrapingError('AUTH_FAILED', `Walmart scraping failed: ${(error as Error).message}`, false)
  } finally {
    await cleanupResources(browser, page)
  }
}

// Best Buy scraping function - IMPLEMENTED  
async function importFromBestBuy(username: string | undefined, password: string | undefined): Promise<ScrapedProduct[]> {
  let browser: Browser | null = null
  let page: Page | null = null

  try {
    browser = await launchSecureBrowser()
    page = await browser.newPage()
    
    // Authenticate with Best Buy
    await authenticateWithRetailer(
      page, 
      username, 
      password, 
      BESTBUY_SELECTORS,
      'BestBuy',
      'https://www.bestbuy.com/identity/signin'
    )
    
    // Extract orders
    const products = await extractOrdersFromRetailer(
      page,
      BESTBUY_SELECTORS,
      'BestBuy',
      'https://www.bestbuy.com/profile/orders',
      5
    )
    
    return products
    
  } catch (error) {
    console.error('Best Buy scraping error:', error)
    if (error instanceof ScrapingError) {
      throw error
    }
    throw new ScrapingError('AUTH_FAILED', `Best Buy scraping failed: ${(error as Error).message}`, false)
  } finally {
    await cleanupResources(browser, page)
  }
}

// Target scraping function - IMPLEMENTED
async function importFromTarget(username: string | undefined, password: string | undefined): Promise<ScrapedProduct[]> {
  let browser: Browser | null = null
  let page: Page | null = null

  try {
    browser = await launchSecureBrowser()
    page = await browser.newPage()
    
    // Authenticate with Target
    await authenticateWithRetailer(
      page, 
      username, 
      password, 
      TARGET_SELECTORS,
      'Target',
      'https://www.target.com/account/signin'
    )
    
    // Extract orders
    const products = await extractOrdersFromRetailer(
      page,
      TARGET_SELECTORS,
      'Target',
      'https://www.target.com/account/orders',
      5
    )
    
    return products
    
  } catch (error) {
    console.error('Target scraping error:', error)
    if (error instanceof ScrapingError) {
      throw error
    }
    throw new ScrapingError('AUTH_FAILED', `Target scraping failed: ${(error as Error).message}`, false)
  } finally {
    await cleanupResources(browser, page)
  }
}

// API key authentication middleware
app.use('/*', bearerAuth({
  token: process.env.SCRAPER_API_KEY || 'fallback-key'
}))

// Main scraping endpoint
app.post('/', async (c) => {
  try {
    const body: ScraperRequest = await c.req.json()
    
    // Validate request structure
    if (!body.retailer || !body.auth || !body.auth.type) {
      return c.json({
        error: 'Invalid request format. Required: retailer, auth.type'
      }, 400)
    }
    
    const { retailer, auth } = body
    let scrapedProducts: ScrapedProduct[] = []
    
    // Route to appropriate scraper based on retailer and auth type
    switch (retailer.toLowerCase()) {
      case 'amazon':
        if (auth.type === 'oauth' && auth.token) {
          scrapedProducts = await scrapeAmazonWithOAuth(
            auth.token,
            body.date_range,
            body.import_options
          )
        } else {
          return c.json({
            error: 'Amazon requires OAuth authentication with token'
          }, 400)
        }
        break
        
      case 'walmart':
        if (auth.type === 'credentials' && auth.username && auth.password) {
          scrapedProducts = await importFromWalmart(auth.username, auth.password)
        } else {
          return c.json({
            error: 'Walmart requires credentials authentication with username and password'
          }, 400)
        }
        break
        
      case 'target':
        if (auth.type === 'credentials' && auth.username && auth.password) {
          scrapedProducts = await importFromTarget(auth.username, auth.password)
        } else {
          return c.json({
            error: 'Target requires credentials authentication with username and password'
          }, 400)
        }
        break
        
      case 'bestbuy':
        if (auth.type === 'credentials' && auth.username && auth.password) {
          scrapedProducts = await importFromBestBuy(auth.username, auth.password)
        } else {
          return c.json({
            error: 'Best Buy requires credentials authentication with username and password'
          }, 400)
        }
        break
        
      default:
        return c.json({
          error: `Unsupported retailer: ${retailer}`
        }, 400)
    }
    
    return c.json({
      success: true,
      retailer: retailer.toLowerCase(),
      products: scrapedProducts,
      count: scrapedProducts.length
    })
    
  } catch (error) {
    console.error('Scraping error:', error)
    
    if (error instanceof ScrapingError) {
      const statusCode = error.type === 'AUTH_FAILED' ? 401 : 
                        error.type === 'CAPTCHA' ? 422 : 500
      
      return c.json({
        error: error.message,
        type: error.type,
        recoverable: error.recoverable
      }, statusCode)
    }
    
    return c.json({
      error: 'Internal scraping service error',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500)
  }
})

// Health check endpoint
app.get('/health', (c) => {
  return c.json({ status: 'healthy', timestamp: new Date().toISOString() })
})

export default app