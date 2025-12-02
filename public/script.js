document.addEventListener('DOMContentLoaded', () => {
    const socket = io();
    const logContainer = document.getElementById('heroku-logs');
    let allProducts = []; 

    // --- NAVIGATION LOGIC ---
    window.switchView = (viewId) => {
        document.querySelectorAll('.view-section').forEach(el => el.style.display = 'none');
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        document.getElementById(`view-${viewId}`).style.display = 'block';
        
        const navIndex = viewId === 'dashboard' ? 0 : 1;
        document.querySelectorAll('.nav-item')[navIndex].classList.add('active');

        if(viewId === 'products') loadProducts();
    };

    // --- PRODUCT MANAGEMENT ---
    window.loadProducts = async () => {
        const tbody = document.getElementById('product-table-body');
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:#666;">Loading...</td></tr>';
        
        try {
            const res = await fetch('/api/products');
            allProducts = await res.json();
            
            tbody.innerHTML = '';
            if(allProducts.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:#666;">No products found. Add one!</td></tr>';
                return;
            }

            allProducts.forEach(p => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td><span style="background:rgba(59,130,246,0.1); color:#60a5fa; padding:4px 8px; border-radius:4px; font-size:0.8rem;">${p.kategori}</span></td>
                    <td style="font-weight:600;">${p.namaProduk}</td>
                    <td style="font-family:'JetBrains Mono', monospace;">Rp ${p.harga.toLocaleString('id-ID')}</td>
                    <td><span style="color:${p.stok > 0 ? '#10b981' : '#ef4444'}">${p.stok} items</span></td>
                    <td style="text-align:right;">
                        <div style="display:inline-flex; gap:5px;">
                            <button class="btn-icon btn-primary" onclick="openEditModal('${p._id}')" title="Edit"><i class="ri-pencil-line"></i></button>
                            <button class="btn-icon btn-success" onclick="openStockModal('${p._id}')" title="Add Stock"><i class="ri-database-2-line"></i></button>
                            <button class="btn-icon btn-danger" onclick="deleteProduct('${p._id}')" title="Delete"><i class="ri-delete-bin-line"></i></button>
                        </div>
                    </td>
                `;
                tbody.appendChild(row);
            });
        } catch (err) { console.error(err); }
    };

    // Handle Add/Edit Form
    window.handleProductSubmit = async (e) => {
        e.preventDefault();
        const id = document.getElementById('prod-id').value;
        const data = {
            kategori: document.getElementById('prod-cat').value,
            namaProduk: document.getElementById('prod-name').value,
            harga: parseInt(document.getElementById('prod-price').value),
            deskripsi: document.getElementById('prod-desc').value
        };

        const url = id ? `/api/products/${id}` : '/api/products';
        const method = id ? 'PUT' : 'POST';

        await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        closeModal('modal-product');
        loadProducts();
    };

    // Handle Stock Form
    window.handleStockSubmit = async (e) => {
        e.preventDefault();
        const id = document.getElementById('stock-prod-id').value;
        const stockData = document.getElementById('stock-data').value;

        await fetch(`/api/products/${id}/stock`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newStock: stockData })
        });

        closeModal('modal-stock');
        loadProducts();
    };

    window.deleteProduct = async (id) => {
        if(!confirm('Are you sure you want to delete this product?')) return;
        await fetch(`/api/products/${id}`, { method: 'DELETE' });
        loadProducts();
    };

    // --- MODAL HELPERS ---
    window.openModal = (id) => {
        document.getElementById(id).style.display = 'flex';
        if(id === 'modal-product') {
            document.getElementById('product-form').reset();
            document.getElementById('prod-id').value = '';
            document.getElementById('modal-title').innerText = 'Add Product';
        }
    };

    window.openEditModal = (id) => {
        const p = allProducts.find(x => x._id === id);
        if(!p) return;
        document.getElementById('prod-id').value = p._id;
        document.getElementById('prod-cat').value = p.kategori;
        document.getElementById('prod-name').value = p.namaProduk;
        document.getElementById('prod-price').value = p.harga;
        document.getElementById('prod-desc').value = p.deskripsi || '';
        document.getElementById('modal-title').innerText = 'Edit Product';
        document.getElementById('modal-product').style.display = 'flex';
    };

    window.openStockModal = (id) => {
        const p = allProducts.find(x => x._id === id);
        document.getElementById('stock-prod-id').value = id;
        document.getElementById('stock-prod-name').innerText = p.namaProduk;
        document.getElementById('stock-data').value = ''; 
        document.getElementById('modal-stock').style.display = 'flex';
    }

    window.closeModal = (id) => document.getElementById(id).style.display = 'none';

    // --- STATS & LOGS ---
    async function fetchStats() {
        try {
            const res = await fetch('/api/stats');
            const s = await res.json();
            document.getElementById('total-users').innerText = s.totalUsers;
            document.getElementById('total-products').innerText = s.totalProducts;
            document.getElementById('success-transactions').innerText = s.successTransactions;
            document.getElementById('pending-transactions').innerText = s.pendingTransactions;
            
            const dbEl = document.getElementById('db-status-text');
            if(s.dbStatus === 'CONNECTED') { dbEl.innerText = 'ONLINE'; dbEl.style.color = '#10b981'; }
            else { dbEl.innerText = s.dbStatus; dbEl.style.color = '#ef4444'; }
            
            document.getElementById('server-uptime').innerText = s.serverUptime;
        } catch (e) { console.log(e); }
    }
    
    socket.on('log', (log) => {
        if(!logContainer) return;
        const span = document.createElement('span');
        span.className = `log-line source-${log.source}`;
        span.innerText = log.line;
        logContainer.appendChild(span);
        if (logContainer.childElementCount > 150) logContainer.removeChild(logContainer.firstChild);
        logContainer.scrollTop = logContainer.scrollHeight;
    });

    fetchStats();
    setInterval(fetchStats, 5000);
});
