export default function HomePage() {
  const stats = [
    { label: 'Revenue', value: '$48,250', change: '+12.5%', up: true },
    { label: 'Users', value: '12,847', change: '+8.2%', up: true },
    { label: 'Orders', value: '1,429', change: '-3.1%', up: false },
    { label: 'Conversion', value: '3.42%', change: '+0.8%', up: true },
  ];

  const chartData = [
    { day: 'Mon', height: 45 },
    { day: 'Tue', height: 62 },
    { day: 'Wed', height: 38 },
    { day: 'Thu', height: 78 },
    { day: 'Fri', height: 55 },
    { day: 'Sat', height: 90 },
    { day: 'Sun', height: 70 },
  ];

  const orders = [
    { id: '#ORD-001', customer: 'Sarah Kim', date: '2025-01-15', status: 'Completed', amount: '$249.00' },
    { id: '#ORD-002', customer: 'James Martinez', date: '2025-01-15', status: 'Pending', amount: '$89.50' },
    { id: '#ORD-003', customer: 'Anna Liu', date: '2025-01-14', status: 'Completed', amount: '$420.00' },
    { id: '#ORD-004', customer: 'Tom Wilson', date: '2025-01-14', status: 'Refunded', amount: '$159.99' },
    { id: '#ORD-005', customer: 'Emma Davis', date: '2025-01-13', status: 'Completed', amount: '$75.25' },
  ];

  return (
    <div>
      <div className="stats">
        {stats.map((s) => (
          <div className="stat-card">
            <div className="label">{s.label}</div>
            <div className="value">{s.value}</div>
            <div className={`change ${s.up ? 'up' : 'down'}`}>
              {s.up ? '↑' : '↓'} {s.change} vs last week
            </div>
          </div>
        ))}
      </div>

      <div className="chart-container">
        <h3>Revenue — Last 7 Days</h3>
        <div className="chart">
          {chartData.map((d) => (
            <div className="bar" style={{ height: `${d.height}%` }}>
              <div className="label">{d.day}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="table-container">
        <h3>Recent Orders</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Order ID</th>
              <th>Customer</th>
              <th>Date</th>
              <th>Status</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr>
                <td>{o.id}</td>
                <td>{o.customer}</td>
                <td>{o.date}</td>
                <td>
                  <span className={`badge ${o.status === 'Completed' ? 'green' : o.status === 'Pending' ? 'yellow' : o.status === 'Refunded' ? 'red' : 'blue'}`}>
                    {o.status}
                  </span>
                </td>
                <td>{o.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
