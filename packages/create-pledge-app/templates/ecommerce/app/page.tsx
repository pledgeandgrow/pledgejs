export default function HomePage() {
  const products = [
    { name: 'Wireless Headphones', category: 'Electronics', price: '$99.99', oldPrice: '$149.99', emoji: '🎧', rating: 4.8, reviews: 342 },
    { name: 'Smart Watch Pro', category: 'Electronics', price: '$199.99', oldPrice: null, emoji: '⌚', rating: 4.6, reviews: 189 },
    { name: 'Coffee Maker', category: 'Home', price: '$79.99', oldPrice: '$99.99', emoji: '☕', rating: 4.5, reviews: 256 },
    { name: 'Running Shoes', category: 'Sports', price: '$129.99', oldPrice: null, emoji: '👟', rating: 4.7, reviews: 421 },
    { name: 'Backpack Elite', category: 'Accessories', price: '$59.99', oldPrice: '$89.99', emoji: '🎒', rating: 4.4, reviews: 178 },
    { name: 'Desk Lamp', category: 'Home', price: '$39.99', oldPrice: null, emoji: '💡', rating: 4.3, reviews: 95 },
    { name: 'Mechanical Keyboard', category: 'Electronics', price: '$149.99', oldPrice: '$179.99', emoji: '⌨️', rating: 4.9, reviews: 567 },
    { name: 'Yoga Mat', category: 'Sports', price: '$29.99', oldPrice: null, emoji: '🧘', rating: 4.2, reviews: 134 },
  ];

  const filters = ['All', 'Electronics', 'Home', 'Sports', 'Accessories'];

  return (
    <div className="container">
      <div className="hero-banner">
        <h1>Summer Sale — Up to 40% Off</h1>
        <p>Discover amazing deals on premium products. Free shipping on orders over $50.</p>
        <a href="#" className="btn">Shop Now →</a>
      </div>

      <h2 className="section-title">Featured Products</h2>

      <div className="filters">
        {filters.map((f, i) => (
          <button className={`filter ${i === 0 ? 'active' : ''}`}>{f}</button>
        ))}
      </div>

      <div className="products">
        {products.map((p) => (
          <div className="product">
            <div className="img">{p.emoji}</div>
            <div className="body">
              <h3>{p.name}</h3>
              <div className="category">{p.category}</div>
              <div className="rating">
                <span className="stars">{'★'.repeat(Math.floor(p.rating))}</span>
                <span>{p.rating} ({p.reviews})</span>
              </div>
              <div>
                <span className="price">{p.price}</span>
                {p.oldPrice && <span className="old-price">{p.oldPrice}</span>}
              </div>
              <button className="add-btn">Add to Cart</button>
            </div>
          </div>
        ))}
      </div>

      <div className="features">
        <div className="feature">
          <div className="icon">🚚</div>
          <h4>Free Shipping</h4>
          <p>On orders over $50</p>
        </div>
        <div className="feature">
          <div className="icon">↩️</div>
          <h4>Easy Returns</h4>
          <p>30-day return policy</p>
        </div>
        <div className="feature">
          <div className="icon">🔒</div>
          <h4>Secure Payment</h4>
          <p>Encrypted checkout</p>
        </div>
        <div className="feature">
          <div className="icon">💬</div>
          <h4>24/7 Support</h4>
          <p>Always here to help</p>
        </div>
      </div>
    </div>
  );
}
