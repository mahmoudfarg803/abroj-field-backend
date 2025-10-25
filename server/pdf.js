import PdfPrinter from 'pdfmake';

const fonts = { Roboto: { normal: 'fonts/Roboto-Regular.ttf', bold: 'fonts/Roboto-Bold.ttf' } };
const printer = new PdfPrinter(fonts);

export async function generateVisitPDFBuffer({ visit, inventory, cash, notes }) {
  const invBody = [ ['#','الصنف','اللون','المقاس','النظام','الفعلي','الفرق'] ];
  (inventory||[]).forEach((r, i)=> invBody.push([ String(i+1), r.item_name, r.color||'', r.size||'', String(r.system_qty), String(r.actual_qty), String((r.actual_qty||0) - (r.system_qty||0)) ]));

  const docDefinition = {
    pageMargins: [30, 60, 30, 40],
    content: [
      { text: 'شركة أبرج للاستشارات المالية والإدارية', style: 'h1', alignment:'center' },
      { text: `تقرير زيارة ميدانية رقم ${visit.id}`, style: 'h2', margin:[0,8,0,12], alignment:'center' },
      {
        columns: [
          { width: '*', text: `الفرع: ${visit.branch_name} — ${visit.location||''}` },
          { width: '*', text: `التاريخ: ${new Date(visit.started_at).toLocaleDateString('ar-EG')}`, alignment: 'right' }
        ], margin:[0,0,0,8]
      },
      { text: 'جرد الخزنة', style: 'section' },
      {
        table: { widths: ['*','*','*','*'], body: [
          ['رصيد النظام','الرصيد الفعلي','المبيعات','الفرق'],
          [ String(cash?.system_balance||0), String(cash?.actual_balance||0), String(cash?.sales_amount||0), String((cash?.actual_balance||0) - (cash?.system_balance||0)) ]
        ] }, margin:[0,4,0,10]
      },
      { text: 'جرد الأصناف', style: 'section' },
      { table: { headerRows:1, widths:[20,'*',60,40,40,40,40], body: invBody } },
      { text: 'الملاحظات', style: 'section', margin:[0,10,0,4] },
      { ul: (notes||[]).map(n=> n.note_text) },
    ],
    styles: { h1:{fontSize:14,bold:true}, h2:{fontSize:12,bold:true}, section:{bold:true} }
  };

  const pdfDoc = printer.createPdfKitDocument(docDefinition);
  const chunks = [];
  return await new Promise(resolve=>{
    pdfDoc.on('data', (d)=> chunks.push(d));
    pdfDoc.on('end', ()=> resolve(Buffer.concat(chunks)) );
    pdfDoc.end();
  });
}
